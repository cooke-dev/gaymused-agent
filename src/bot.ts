// bot.ts: the Telegram sidecar. Pure glue over the proven components: reader -> brain -> intent
// builder -> signing/approve handoff -> submission. It adds NO new settlement logic. Hard rules it
// keeps: it never sees or holds a user key (signing and the approve() happen in the user's own
// wallet via the handoff), it runs ONE long-lived handoff server for the whole session, it is
// GIWA-only with no relay, and it surfaces the over-limit refusal clearly in chat.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { AppConfig } from "./config";
import { makeProvider, readOnChainState } from "./reader";
import { decide, describeState, type BrainOptions } from "./brain";
import { buildIntent } from "./intent-builder";
import { HandoffServer, type ApprovalRequest } from "./handoff";
import { openViaHub, settleStream, readStream } from "./actions";
import { TelegramClient, type TgMessage } from "./telegram";
import { LanguageStore } from "./language-store";
import { normalizeLanguage, t, type Language } from "./i18n";

const HANDOFF_TTL_SECONDS = 1800; // matches the 30-minute open window the streams use
const POLL_TIMEOUT_SECONDS = 30;
const ACCRUAL_WAIT_MS = 20_000;
const TELEGRAM_START_RETRY_MS = 5_000;

export class TelegramSidecar {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly agentWallet: ethers.Wallet;
  private readonly tg: TelegramClient;
  private readonly logo: Uint8Array;
  private readonly handoff: HandoffServer;
  private readonly brainOpts: BrainOptions;
  private readonly languages: LanguageStore;
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
    this.logo = readFileSync(resolve(process.cwd(), "assets/midiumor-logo-option-2.png"));
    this.handoff = new HandoffServer(cfg.network, { ttlSeconds: HANDOFF_TTL_SECONDS });
    this.languages = new LanguageStore();
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
    await this.configureTelegramWithRetry();
    const me = await this.tg.getMe();
    console.log(`Sidecar up on ${this.cfg.network.name} (chain ${this.cfg.network.chainId}).`);
    console.log(`Bot: @${me.username}  Agent wallet: ${this.agentWallet.address} (${ethers.formatEther(gas)} ETH)`);
    this.running = true;
    await this.loop();
  }

  private async configureTelegramWithRetry(): Promise<void> {
    const commands = [
      { command: "start", description: "Show the welcome guide" },
      { command: "help", description: "Show commands and payment examples" },
      { command: "wallet", description: "Set the wallet that will sign" },
      { command: "state", description: "Read balance and active streams" },
      { command: "stream", description: "Request a capped streaming payment" },
      { command: "pay", description: "Request a capped one-time payment" },
      { command: "cancel", description: "Cancel a pending signing request" },
      { command: "language", description: "Choose English or Korean" },
    ];
    const koreanCommands = [
      { command: "start", description: "시작 안내 보기" },
      { command: "help", description: "명령어와 결제 예시 보기" },
      { command: "wallet", description: "서명할 지갑 설정" },
      { command: "state", description: "잔액과 활성 스트림 확인" },
      { command: "stream", description: "한도가 있는 스트리밍 결제 요청" },
      { command: "pay", description: "한도가 있는 일회성 결제 요청" },
      { command: "cancel", description: "대기 중인 서명 요청 취소" },
      { command: "language", description: "영어 또는 한국어 선택" },
    ];
    while (true) {
      try {
        await this.tg.setMyDescription(
          "Bounded-payment copilot on GIWA. Check your state, then ask for a capped stream or one-time payment. You sign and approve in your own wallet; the Vault enforces the limit.",
        );
        await this.tg.setMyCommands(commands);
        await this.tg.setMyCommands(koreanCommands, "ko");
        await this.tg.getMe();
        return;
      } catch (err) {
        console.error(
          "Telegram startup check failed; retrying:",
          err instanceof Error ? err.message : err,
        );
        await new Promise((resolve) => setTimeout(resolve, TELEGRAM_START_RETRY_MS));
      }
    }
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
    this.ensureLanguage(msg);
    try {
      if (text.startsWith("/start") || text.startsWith("/help")) return this.cmdHelp(chatId);
      if (/^\/?(?:language|lang)(?:@\S+)?(?:\s|$)/i.test(text)) return this.cmdLanguage(chatId, text);
      if (/^\/?(?:ko|korean)$/i.test(text)) return this.cmdLanguage(chatId, "/language ko");
      if (/^\/?(?:en|english)$/i.test(text)) return this.cmdLanguage(chatId, "/language en");
      if (text.startsWith("/wallet")) return this.cmdWallet(chatId, text);
      if (text.startsWith("/state")) return this.cmdState(chatId);
      if (/^\/cancel(?:@\S+)?$/i.test(text)) return this.cmdCancel(chatId);
      if (/^\/stream(?:@\S+)?$/i.test(text)) {
        return this.send(chatId, t(this.languageFor(chatId), "usageStream", { symbol: this.cfg.network.tokenSymbol }));
      }
      if (/^\/pay(?:@\S+)?$/i.test(text)) {
        return this.send(chatId, t(this.languageFor(chatId), "usagePay", { symbol: this.cfg.network.tokenSymbol }));
      }
      if (/^\/stream(?:@\S+)?\s+/i.test(text)) {
        return this.handleRequest(chatId, text.replace(/^\/stream(?:@\S+)?\s+/i, "").trim());
      }
      if (/^\/pay(?:@\S+)?\s+/i.test(text)) {
        return this.handleRequest(chatId, text.replace(/^\/pay(?:@\S+)?\s+/i, "").trim());
      }
      if (text.startsWith("/")) return this.send(chatId, t(this.languageFor(chatId), "unknown"));
      return await this.handleRequest(chatId, text);
    } catch (err) {
      await this.send(chatId, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cmdHelp(chatId: number): Promise<void> {
    const language = this.languageFor(chatId);
    const sym = this.cfg.network.tokenSymbol;
    await this.tg.sendPhoto(chatId, this.logo, "MidiumOR | Bounded payments for AI agents");
    await this.send(
      chatId,
      [
        t(language, "helpTitle", { network: this.cfg.network.name }),
        t(language, "helpIntro", { symbol: sym }),
        t(language, "helpVault"),
        "",
        t(language, "helpWallet"),
        t(language, "helpState"),
        t(language, "helpCancel"),
        t(language, "helpAsk"),
        t(language, "helpStream", { symbol: sym }),
        t(language, "helpPay", { symbol: sym }),
        "",
        t(language, "helpSafety"),
        "",
        t(language, "languagePrompt"),
      ].join("\n"),
    );
  }

  private cmdLanguage(chatId: number, text: string): Promise<void> {
    const arg = text.replace(/^\/?(?:language|lang)(?:@\S+)?\s*/i, "").trim().toLowerCase();
    if (!arg) return this.send(chatId, t(this.languageFor(chatId), "languagePrompt"));
    if (arg === "en" || arg === "english") {
      this.languages.set(chatId, "en");
      return this.send(chatId, t("en", "languageSetEn"));
    }
    if (arg === "ko" || arg === "korean") {
      this.languages.set(chatId, "ko");
      return this.send(chatId, t("ko", "languageSetKo"));
    }
    return this.send(chatId, t(this.languageFor(chatId), "languageUsage"));
  }

  private ensureLanguage(msg: TgMessage): void {
    if (!this.languages.has(msg.chat.id)) {
      this.languages.set(msg.chat.id, normalizeLanguage(msg.from?.language_code));
    }
  }

  private languageFor(chatId: number): Language {
    return this.languages.get(chatId);
  }
  private cmdWallet(chatId: number, text: string): Promise<void> {
    const arg = text.replace(/^\/wallet(@\S+)?\s*/, "").trim();
    if (!arg) return this.send(chatId, t(this.languageFor(chatId), "walletUsage"));
    if (!ethers.isAddress(arg)) return this.send(chatId, t(this.languageFor(chatId), "invalidAddress", { address: arg }));
    const addr = ethers.getAddress(arg);
    this.wallets.set(chatId, addr);
    return this.send(chatId, t(this.languageFor(chatId), "walletSet", { address: addr }));
  }

  private async cmdState(chatId: number): Promise<void> {
    const wallet = this.wallets.get(chatId);
    if (!wallet) return this.send(chatId, t(this.languageFor(chatId), "noWallet"));
    await this.send(chatId, t(this.languageFor(chatId), "readingState"));
    const state = await readOnChainState(this.provider, this.cfg.network, wallet, { includePaycards: true });
    await this.send(chatId, describeState(state, this.languageFor(chatId)));
  }

  private cmdCancel(chatId: number): Promise<void> {
    const handoffId = this.pendingHandoffs.get(chatId);
    if (!handoffId) return this.send(chatId, t(this.languageFor(chatId), "noPending"));
    this.pendingHandoffs.delete(chatId);
    this.handoff.cancelHandoff(handoffId);
    return this.send(chatId, t(this.languageFor(chatId), "cancelled"));
  }
  private async handleRequest(chatId: number, text: string): Promise<void> {
    const language = this.languageFor(chatId);
    const wallet = this.wallets.get(chatId);
    if (!wallet) return this.send(chatId, t(language, "noWallet"));

    await this.send(chatId, t(language, "thinking"));
    const state = await readOnChainState(this.provider, this.cfg.network, wallet, { includePaycards: true });

    let proposal;
    try {
      proposal = await decide(state, text, { ...this.brainOpts, language });
    } catch {
      const sym = this.cfg.network.tokenSymbol;
      return this.send(
        chatId,
        t(language, "brainFail", { symbol: sym }),
      );
    }

    if (proposal.action === "answer_state") {
      return this.send(chatId, proposal.answer ?? proposal.explanation);
    }
    if (proposal.action === "unsupported") {
      return this.send(chatId, t(language, "unsupported", { reason: proposal.reason ?? proposal.explanation }));
    }

    // THE OVER-LIMIT BLOCK, surfaced in chat before anything is signed or spent.
    if (!proposal.feasible) {
      return this.send(
        chatId,
        [
          "⛔ " + t(language, "refusalHeader"),
          proposal.reason ?? "the request is outside your bounds",
          "",
          t(language, "refusalBody"),
          t(language, "nothingMoved"),
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
    const language = this.languageFor(chatId);
    const net = this.cfg.network;
    const built = buildIntent(proposal, state, net);
    const pool = built.baseUnits.totalAllocationPool;
    const approval: ApprovalRequest = { token: net.tokenAddress, spender: net.hubAddress, value: pool };
    const { id: handoffId, url, signed } = this.handoff.createHandoff(built, proposal.explanation, approval, language);
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
