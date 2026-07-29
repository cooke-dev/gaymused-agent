// bot.ts: the Telegram sidecar. Pure glue over the proven components: reader -> brain -> intent
// builder -> signing/approve handoff -> submission. It adds NO new settlement logic. Hard rules it
// keeps: it never sees or holds a user key (signing and the approve() happen in the user's own
// wallet via the handoff), it runs ONE long-lived handoff server for the whole session, it is
// GIWA-only with no relay, and it surfaces the over-limit refusal clearly in chat.
import { ethers } from "ethers";
import type { AppConfig } from "./config";
import { makeProvider, readOnChainState } from "./reader";
import { decide, describeState, type BrainOptions } from "./brain";
import { buildIntent } from "./intent-builder";
import { HandoffServer, type ApprovalRequest } from "./handoff";
import { openViaHub, settleStream, readStream } from "./actions";
import { TelegramClient, type TgMessage } from "./telegram";

const HANDOFF_TTL_SECONDS = 1800; // matches the 30-minute open window the streams use
const POLL_TIMEOUT_SECONDS = 30;
const ACCRUAL_WAIT_MS = 20_000;

export class TelegramSidecar {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly agentWallet: ethers.Wallet;
  private readonly tg: TelegramClient;
  private readonly handoff: HandoffServer;
  private readonly brainOpts: BrainOptions;
  /** Payer wallet the user set for their chat. The key stays in their wallet; we only hold the address. */
  private readonly wallets = new Map<number, string>();
  /** Pending handoff id per chat, used only for local cancellation before signing completes. */
  private readonly pendingHandoffs = new Map<number, string>();
  private running = false;

  constructor(private readonly cfg: AppConfig) {
    if (!cfg.payerPrivateKey) throw new Error("OPENRAILS_PAYER_PRIVATE_KEY is required (agent gas wallet).");
    if (!cfg.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is required for the decision brain.");
    if (!cfg.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is required for the sidecar.");
    this.provider = makeProvider(cfg.network);
    this.agentWallet = new ethers.Wallet(cfg.payerPrivateKey, this.provider);
    this.tg = new TelegramClient(cfg.telegramBotToken);
    this.handoff = new HandoffServer(cfg.network, { ttlSeconds: HANDOFF_TTL_SECONDS });
    this.brainOpts = { apiKey: cfg.openRouterApiKey, model: cfg.openRouterModel };
  }

  async start(): Promise<void> {
    // The agent wallet pays gas for open and settle; stop early if it cannot.
    const gas = await this.provider.getBalance(this.agentWallet.address);
    if (gas === 0n) {
      throw new Error(
        `Agent gas wallet ${this.agentWallet.address} holds no ${this.cfg.network.name} ETH. Fund it and restart.`,
      );
    }
    await this.handoff.start(); // ONE long-lived signing server for the whole session
    await this.tg.setMyDescription(
      "Bounded-payment copilot on GIWA. Check your state, then ask for a capped stream or one-time payment. You sign and approve in your own wallet; the Vault enforces the limit.",
    );
    await this.tg.setMyCommands([
      { command: "start", description: "Show the welcome guide" },
      { command: "help", description: "Show commands and payment examples" },
      { command: "wallet", description: "Set the wallet that will sign" },
      { command: "state", description: "Read balance and active streams" },
      { command: "stream", description: "Request a capped streaming payment" },
      { command: "pay", description: "Request a capped one-time payment" },
      { command: "cancel", description: "Cancel a pending signing request" },
    ]);    const me = await this.tg.getMe();
    console.log(`Sidecar up on ${this.cfg.network.name} (chain ${this.cfg.network.chainId}).`);
    console.log(`Bot: @${me.username}  Agent wallet: ${this.agentWallet.address} (${ethers.formatEther(gas)} ETH)`);
    this.running = true;
    await this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.handoff.stop();
  }

  /** Long-poll Telegram. Each message is handled on its own task so a pending signature never blocks polling. */
  private async loop(): Promise<void> {
    let offset = 0;
    while (this.running) {
      let updates;
      try {
        updates = await this.tg.getUpdates(offset, POLL_TIMEOUT_SECONDS);
      } catch (err) {
        console.error("getUpdates failed, retrying:", err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message?.text) void this.handleMessage(u.message);
      }
    }
  }

  private async send(chatId: number, text: string): Promise<void> {
    try {
      await this.tg.sendMessage(chatId, text);
    } catch (err) {
      console.error("sendMessage failed:", err instanceof Error ? err.message : err);
    }
  }

  private txLink(hash: string): string {
    return `${this.cfg.network.explorerBaseUrl}/tx/${hash}`;
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();
    try {
      if (text.startsWith("/start") || text.startsWith("/help")) return this.cmdHelp(chatId);
      if (text.startsWith("/wallet")) return this.cmdWallet(chatId, text);
      if (text.startsWith("/state")) return this.cmdState(chatId);
      if (/^\/cancel(?:@\S+)?$/i.test(text)) return this.cmdCancel(chatId);
      if (/^\/stream(?:@\S+)?$/i.test(text)) {
        return this.send(chatId, "Usage: /stream 0.09 orUSD to 0xRecipient over 30 minutes");
      }
      if (/^\/pay(?:@\S+)?$/i.test(text)) {
        return this.send(chatId, "Usage: /pay 0.25 orUSD to 0xRecipient");
      }
      if (/^\/stream(?:@\S+)?\s+/i.test(text)) {
        return this.handleRequest(chatId, text.replace(/^\/stream(?:@\S+)?\s+/i, "").trim());
      }
      if (/^\/pay(?:@\S+)?\s+/i.test(text)) {
        return this.handleRequest(chatId, text.replace(/^\/pay(?:@\S+)?\s+/i, "").trim());
      }
      if (text.startsWith("/")) return this.send(chatId, "Unknown command. Try /help.");
      return await this.handleRequest(chatId, text);
    } catch (err) {
      await this.send(chatId, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private cmdHelp(chatId: number): Promise<void> {
    const sym = this.cfg.network.tokenSymbol;
    return this.send(
      chatId,
      [
        `Bounded-payment copilot on ${this.cfg.network.name}. I propose ${sym} payments with a hard cap;`,
        "you sign and approve in your own wallet; the on-chain Vault enforces the bounds. I never hold your key.",
        "",
        "1) Set your wallet:  /wallet 0xYourAddress",
        "2) Check it:         /state",
        "3) Cancel a pending signing link: /cancel",
        "4) Ask in plain language, for example:",
        `   • stream 0.09 ${sym} to 0xRecipient over 30 minutes`,
        `   • pay 0.25 ${sym} to 0xRecipient`,
        "",
        "I refuse anything over your balance before you ever sign, and the Vault caps what I can move even after you do.",
      ].join("\n"),
    );
  }

  private cmdWallet(chatId: number, text: string): Promise<void> {
    const arg = text.replace(/^\/wallet(@\S+)?\s*/, "").trim();
    if (!arg) return this.send(chatId, "Usage: /wallet 0xYourAddress");
    if (!ethers.isAddress(arg)) return this.send(chatId, `That is not a valid address: ${arg}`);
    const addr = ethers.getAddress(arg);
    this.wallets.set(chatId, addr);
    return this.send(chatId, `Wallet set to ${addr}. This is the address you will sign and approve with. Try /state.`);
  }

  private async cmdState(chatId: number): Promise<void> {
    const wallet = this.wallets.get(chatId);
    if (!wallet) return this.send(chatId, "Set your wallet first: /wallet 0xYourAddress");
    await this.send(chatId, "Reading your on-chain state...");
    const state = await readOnChainState(this.provider, this.cfg.network, wallet, { includePaycards: true });
    await this.send(chatId, describeState(state));
  }

  private cmdCancel(chatId: number): Promise<void> {
    const handoffId = this.pendingHandoffs.get(chatId);
    if (!handoffId) return this.send(chatId, "There is no pending signing request to cancel.");
    this.pendingHandoffs.delete(chatId);
    this.handoff.cancelHandoff(handoffId);
    return this.send(chatId, "Pending signing request cancelled. Nothing was signed and nothing moved.");
  }
  private async handleRequest(chatId: number, text: string): Promise<void> {
    const wallet = this.wallets.get(chatId);
    if (!wallet) return this.send(chatId, "Set your wallet first: /wallet 0xYourAddress, then ask again.");

    await this.send(chatId, "Reading your on-chain state and thinking...");
    const state = await readOnChainState(this.provider, this.cfg.network, wallet, { includePaycards: true });

    let proposal;
    try {
      proposal = await decide(state, text, this.brainOpts);
    } catch {
      const sym = this.cfg.network.tokenSymbol;
      return this.send(
        chatId,
        `I could not turn that into a bounded payment. Try: stream 0.09 ${sym} to 0xRecipient over 30 minutes`,
      );
    }

    if (proposal.action === "answer_state") {
      return this.send(chatId, proposal.answer ?? proposal.explanation);
    }
    if (proposal.action === "unsupported") {
      return this.send(chatId, `I can't do that. ${proposal.reason ?? proposal.explanation}`);
    }

    // THE OVER-LIMIT BLOCK, surfaced in chat before anything is signed or spent.
    if (!proposal.feasible) {
      return this.send(
        chatId,
        [
          "⛔ Refused before signing.",
          proposal.reason ?? "the request is outside your bounds",
          "",
          "The budget is bounded, so I won't ask you to authorize something the Vault couldn't back.",
          "Nothing was signed and nothing moved.",
        ].join("\n"),
      );
    }

    await this.runSignedLoop(chatId, wallet, proposal, state);
  }

  /** The proven loop: build -> handoff (sign + approve in the user's wallet) -> open -> settle. */
  private async runSignedLoop(
    chatId: number,
    wallet: string,
    proposal: Awaited<ReturnType<typeof decide>>,
    state: Awaited<ReturnType<typeof readOnChainState>>,
  ): Promise<void> {
    const net = this.cfg.network;
    const built = buildIntent(proposal, state, net);
    const pool = built.baseUnits.totalAllocationPool;
    const approval: ApprovalRequest = { token: net.tokenAddress, spender: net.hubAddress, value: pool };
    const { id: handoffId, url, signed } = this.handoff.createHandoff(built, proposal.explanation, approval);
    this.pendingHandoffs.set(chatId, handoffId);

    await this.send(
      chatId,
      [
        proposal.explanation,
        "",
        this.describeBounds(proposal),
        "",
        "Open this on this computer and sign, then send the approve() in your wallet:",
        url,
        "",
        "Heads up: your wallet may show a 'deceptive request' warning. That is a known false positive for",
        "local testnet signing to an unverified contract; the request details are correct and it is safe to confirm.",
        `The link is valid for ${HANDOFF_TTL_SECONDS / 60} minutes.`,
      ].join("\n"),
    );

    let handoff;
    try {
      handoff = await signed;
    } catch {
      return this.send(chatId, "That signing link expired before it was used. Ask again for a fresh one. Nothing moved.");
    }

    if (this.pendingHandoffs.get(chatId) === handoffId) this.pendingHandoffs.delete(chatId);

    if (handoff.approveTxHash) {
      await this.send(chatId, `Signed by ${handoff.signerAddress}. Approval confirmed:\n${this.txLink(handoff.approveTxHash)}\nOpening now...`);
    } else {
      await this.send(chatId, `Signed by ${handoff.signerAddress}. Opening now...`);
    }

    const opened = await openViaHub(handoff.envelopeToken, this.agentWallet, net, { pool, payer: wallet });
    if (!opened.ok) {
      return this.send(
        chatId,
        [`⛔ Blocked on-chain by the ${opened.blockedBy}. Nothing moved.`, opened.reason].join("\n"),
      );
    }
    await this.send(chatId, `Opened. The escrow is now bounded in the Vault:\n${this.txLink(opened.txHash)}`);

    // Settle once to show value flowing within the cap. This is a permissionless crank: it can never
    // pay out more than the Vault has metered, so it cannot exceed what was signed.
    await this.send(chatId, "Letting value accrue, then settling once to show funds flowing within the cap...");
    await new Promise((r) => setTimeout(r, ACCRUAL_WAIT_MS));
    const settled = await settleStream(built.intent.paycardId, this.agentWallet, net, this.provider);
    const fmt = (v: bigint | string) => ethers.formatUnits(v, state.tokenDecimals);
    if (!settled.ok) {
      await this.send(chatId, `Settle did not run: ${settled.reason}`);
    } else {
      const view = await readStream(built.intent.paycardId, net, this.provider);
      await this.send(
        chatId,
        [
          `Settled ${fmt(settled.settledAmount)} ${net.tokenSymbol} to the recipient:`,
          this.txLink(settled.txHash),
          `Remaining in the Vault: ${fmt(view.availableBalance)} of ${fmt(view.totalAllocationPool)} ${net.tokenSymbol}.`,
          "The agent can never move more than the cap you signed.",
        ].join("\n"),
      );
    }
  }

  private describeBounds(proposal: Awaited<ReturnType<typeof decide>>): string {
    const sym = this.cfg.network.tokenSymbol;
    const pay = proposal.payment!;
    const lines = [`Cap (Vault enforced): ${pay.totalAllocation} ${sym}`, `Recipient: ${pay.recipient}`];
    if (pay.rate && proposal.action === "open_stream") {
      lines.push(`Rate: ${pay.rate.amount} ${sym}/${pay.rate.per}`);
      if (pay.durationSeconds) lines.push(`Duration: ${pay.durationSeconds} seconds`);
    }
    return lines.join("\n");
  }
}
