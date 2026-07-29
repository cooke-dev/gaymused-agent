// handoff.ts: signing handoff. Serves human readable terms for a BuiltIntent, the user signs the
// SDK's exact typed data in their OWN browser wallet, and, when escrow needs approving, sends a
// standard ERC-20 approve() from that same wallet. Only the signature and the approve tx hash return.
// The daemon never sees, requests, or stores a key: the signing and the approve both happen in the
// user's wallet. orUSD has no EIP-2612 permit, so allowance is set by approve(), not a signed permit.
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import {
  OPENRAILS_EIP712_TYPES,
  buildSettlementIntentValue,
  serializeEnvelope,
  type CryptographicEnvelopeV1,
} from "openrails-sdk";
import type { BuiltIntent } from "./intent-builder";
import type { NetworkConfig } from "./config";

/** A standard ERC-20 approve the payer must send so the hub can pull escrow under transferFrom. */
export interface ApprovalRequest {
  token: string;
  spender: string;
  /** Amount to approve, in token base units. */
  value: string;
}

export interface SignedHandoff {
  handoffId: string;
  signerAddress: string;
  signature: string;
  /** Serialized CryptographicEnvelopeV1, exactly what the relay or hub consumes. */
  envelopeToken: string;
  /** Present when an approve() was requested and sent. The tx that set the hub's allowance. */
  approveTxHash?: string;
}

interface PendingHandoff {
  built: BuiltIntent;
  explanation: string;
  approval?: ApprovalRequest;
  expiresAt: number;
  used: boolean;
  resolve: (signed: SignedHandoff) => void;
  reject: (err: Error) => void;
}

const DEFAULT_TTL_SECONDS = 600;
const ERC20_APPROVE_IFACE = new ethers.Interface(["function approve(address spender,uint256 value)"]);

/** Human readable terms derived deterministically from the intent's base units. */
function describeTerms(built: BuiltIntent, network: NetworkConfig): Record<string, string> {
  const { intent } = built;
  const cap = ethers.formatUnits(intent.totalAllocationPool, network.tokenDecimals);
  const terms: Record<string, string> = {
    Action: intent.lifespanSeconds === 0 ? "One-time payment" : "Streaming payment",
    Token: network.tokenSymbol,
    Recipient: intent.recipient,
    "Hard cap (Vault enforced)": `${cap} ${network.tokenSymbol}`,
  };
  if (intent.lifespanSeconds > 0) {
    const perHour = (BigInt(intent.flowVelocityPerSecond) * 3600n).toString();
    terms["Rate"] = `${ethers.formatUnits(perHour, network.tokenDecimals)} ${network.tokenSymbol}/hour (metered per second)`;
    terms["Duration"] = `${intent.lifespanSeconds} seconds`;
  }
  terms["Residual"] = `unused funds return to ${intent.residualDeltaRecipient}`;
  return terms;
}

function pageHtml(entry: PendingHandoff, network: NetworkConfig): string {
  const { built, explanation, approval } = entry;
  const eip712Domain = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  const intentTypedData = {
    types: { EIP712Domain: eip712Domain, ...OPENRAILS_EIP712_TYPES },
    primaryType: "SettlementIntent",
    domain: built.domain,
    message: buildSettlementIntentValue(built.intent),
  };
  const approveTx = approval
    ? {
        to: approval.token,
        data: ERC20_APPROVE_IFACE.encodeFunctionData("approve", [approval.spender, approval.value]),
        valueLabel: `${ethers.formatUnits(approval.value, network.tokenDecimals)} ${network.tokenSymbol}`,
      }
    : null;
  const walletChain = {
    chainId: "0x" + network.chainId.toString(16),
    chainName: network.name,
    nativeCurrency: {
      name: "Ether", // gas on GIWA is native ETH, separate from the orUSD settlement token
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: [network.rpcUrl],
  };
  const rows = Object.entries(describeTerms(built, network))
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");
  const approveNote = approveTx
    ? `<p><strong>One signature, then one transaction.</strong> First you sign the payment terms (a
       signature, not a transaction). Then you send a standard token approval of ${approveTx.valueLabel}
       so the Vault can pull the escrow you authorized. The approval is an on-chain transaction and
       costs a little GIWA ETH. The agent never holds your key: both happen in your own wallet.</p>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>Review and sign</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd;word-break:break-all}
th{white-space:nowrap;vertical-align:top}
button{font-size:1.05rem;padding:.6rem 1.4rem;cursor:pointer}
#status{margin-top:1rem;font-weight:600}
.explain{background:#f5f5f5;border-radius:8px;padding:.8rem 1rem}
</style></head><body>
<h2>Review what you are authorizing</h2>
<p class="explain">${explanation}</p>
<table>${rows}</table>
<p>The Vault enforces these bounds on-chain. Nothing can move more than the hard cap, even if the agent misbehaves.</p>
${approveNote}
<button id="sign">Connect wallet and sign</button>
<div id="status"></div>
<script>
const INTENT_DATA = ${JSON.stringify(intentTypedData)};
const APPROVE_TX = ${JSON.stringify(approveTx)};
const WALLET_CHAIN = ${JSON.stringify(walletChain)};
const status = (m) => { document.getElementById("status").textContent = m; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById("sign").onclick = async () => {
  try {
    if (!window.ethereum) { status("No browser wallet found. Install MetaMask or similar."); return; }
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: WALLET_CHAIN.chainId }] });
    } catch (e) {
      if (e && (e.code === 4902 || String(e.message||"").includes("nrecognized"))) {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [WALLET_CHAIN] });
      }
    }
    status("Step 1: review and sign the payment terms in your wallet.");
    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(INTENT_DATA)],
    });
    let approveTxHash = null;
    if (APPROVE_TX) {
      status("Step 2: approve the token spend in your wallet (a transaction).");
      approveTxHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: APPROVE_TX.to, data: APPROVE_TX.data }],
      });
      status("Waiting for the approval to confirm on-chain...");
      let receipt = null;
      for (let i = 0; i < 60 && !receipt; i++) {
        await sleep(2000);
        receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [approveTxHash] });
      }
      if (!receipt) { status("Approval did not confirm in time. Check your wallet and retry."); return; }
      if (receipt.status !== "0x1") { status("Approval transaction reverted on-chain."); return; }
    }
    status("Sending the result back to the agent...");
    const res = await fetch(location.pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature, address, approveTxHash }),
    });
    const body = await res.json();
    status(res.ok ? "Done. You can close this tab, the agent is taking it from here." : "Rejected: " + body.error);
  } catch (err) { status("Failed: " + (err.message || err)); }
};
</script></body></html>`;
}

export class HandoffServer {
  private app: FastifyInstance;
  private pending = new Map<string, PendingHandoff>();
  private baseUrl = "";

  constructor(
    private network: NetworkConfig,
    private opts: { port?: number; ttlSeconds?: number } = {},
  ) {
    this.app = Fastify({ logger: false });
    this.routes();
  }

  private lookup(id: string): { entry?: PendingHandoff; error?: string } {
    const entry = this.pending.get(id);
    if (!entry) return { error: "unknown handoff id" };
    if (entry.used) return { error: "this signing link was already used" };
    if (Date.now() > entry.expiresAt) return { error: "this signing link has expired" };
    return { entry };
  }

  private routes(): void {
    this.app.get<{ Params: { id: string } }>("/sign/:id", async (req, reply) => {
      const { entry, error } = this.lookup(req.params.id);
      if (!entry) return reply.code(410).type("text/html").send(`<p>${error}</p>`);
      return reply.type("text/html").send(pageHtml(entry, this.network));
    });

    this.app.post<{
      Params: { id: string };
      Body: { signature?: string; address?: string; approveTxHash?: string | null };
    }>("/sign/:id", async (req, reply) => {
      const { entry, error } = this.lookup(req.params.id);
      if (!entry) return reply.code(410).send({ error });

      const { signature, address, approveTxHash } = req.body ?? {};
      if (!signature || !address || !ethers.isAddress(address)) {
        return reply.code(400).send({ error: "signature and address are required" });
      }

      // Verify against the SDK's exact domain, types, and value, the same data the wallet displayed.
      let recovered: string;
      try {
        recovered = ethers.verifyTypedData(
          entry.built.domain,
          OPENRAILS_EIP712_TYPES,
          buildSettlementIntentValue(entry.built.intent),
          signature,
        );
      } catch {
        return reply.code(400).send({ error: "signature does not verify against the intent" });
      }
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return reply.code(400).send({ error: `signature recovers to ${recovered}, not the connected address` });
      }

      // When escrow needs approving, the payer sends approve() from their own wallet and returns its
      // hash. The real guard is on-chain: the open re-reads the allowance before pulling escrow, so
      // a bad or missing hash simply blocks the open rather than moving any money.
      if (entry.approval && !approveTxHash) {
        return reply.code(400).send({ error: "approval transaction hash is required" });
      }

      entry.used = true; // single use, burn before resolving
      const envelope: CryptographicEnvelopeV1 = {
        payerAddress: recovered,
        envelopeSignature: signature,
        intent: entry.built.intent,
        mode: entry.built.mode,
        metadata: entry.built.metadata,
      };
      entry.resolve({
        handoffId: req.params.id,
        signerAddress: recovered,
        signature,
        envelopeToken: serializeEnvelope(envelope),
        approveTxHash: approveTxHash ?? undefined,
      });
      return reply.send({ ok: true, signer: recovered });
    });
  }

  async start(): Promise<string> {
    const port = this.opts.port ?? 8787;

    await this.app.listen({ port, host: "127.0.0.1" });
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  /** Register an intent for signing. Returns the one-time URL and a promise for the result. */
  createHandoff(
    built: BuiltIntent,
    explanation: string,
    approval?: ApprovalRequest,
  ): { id: string; url: string; signed: Promise<SignedHandoff> } {
    const id = randomBytes(16).toString("hex");
    const ttl = (this.opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    let resolve!: (s: SignedHandoff) => void;
    let reject!: (e: Error) => void;
    const signed = new Promise<SignedHandoff>((res, rej) => ((resolve = res), (reject = rej)));
    const entry: PendingHandoff = {
      built,
      explanation,
      approval,
      expiresAt: Date.now() + ttl,
      used: false,
      resolve,
      reject,
    };
    this.pending.set(id, entry);
    setTimeout(() => {
      if (!entry.used) {
        entry.used = true;
        reject(new Error("signing handoff expired"));
      }
      this.pending.delete(id);
    }, ttl).unref?.();
    return { id, url: `${this.baseUrl}/sign/${id}`, signed };
  }

  /** Cancel a pending signing request without touching any on-chain state. */
  cancelHandoff(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.used) return false;
    entry.used = true;
    this.pending.delete(id);
    entry.reject(new Error("signing handoff cancelled"));
    return true;
  }
  async stop(): Promise<void> {
    await this.app.close();
  }
}
