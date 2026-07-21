// handoff.ts — signing handoff: serves human-readable terms for a BuiltIntent, the user signs the
// SDK's exact typed data in their OWN browser wallet, only the signature returns. Keys never touch us.
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

export interface SignedHandoff {
  handoffId: string;
  signerAddress: string;
  signature: string;
  /** Serialized CryptographicEnvelopeV1 — exactly what component 6 submits to the hub. */
  envelopeToken: string;
}

interface PendingHandoff {
  built: BuiltIntent;
  explanation: string;
  expiresAt: number;
  used: boolean;
  resolve: (signed: SignedHandoff) => void;
  reject: (err: Error) => void;
  signed: Promise<SignedHandoff>;
}

const DEFAULT_TTL_SECONDS = 600;

/** Human-readable terms derived deterministically from the intent's base units. */
function describeTerms(built: BuiltIntent, network: NetworkConfig): Record<string, string> {
  const { intent } = built;
  const cap = ethers.formatUnits(intent.totalAllocationPool, network.tokenDecimals);
  const terms: Record<string, string> = {
    Action: intent.lifespanSeconds === 0 ? "One-time payment" : "Streaming payment",
    Token: network.tokenSymbol,
    Recipient: intent.recipient,
    "Hard cap (Vault-enforced)": `${cap} ${network.tokenSymbol}`,
  };
  if (intent.lifespanSeconds > 0) {
    const perHour = (BigInt(intent.flowVelocityPerSecond) * 3600n).toString();
    terms["Rate"] = `${ethers.formatUnits(perHour, network.tokenDecimals)} ${network.tokenSymbol}/hour (metered per second)`;
    terms["Duration"] = `${intent.lifespanSeconds} seconds`;
  }
  terms["Residual"] = `unused funds return to ${intent.residualDeltaRecipient}`;
  return terms;
}

function pageHtml(id: string, built: BuiltIntent, explanation: string, network: NetworkConfig): string {
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...OPENRAILS_EIP712_TYPES,
    },
    primaryType: "SettlementIntent",
    domain: built.domain,
    message: buildSettlementIntentValue(built.intent),
  };
  const walletChain = {
    chainId: "0x" + network.chainId.toString(16),
    chainName: network.name,
    nativeCurrency: {
      name: network.gasIsSeparateAsset ? "Ether" : network.tokenSymbol,
      symbol: network.gasIsSeparateAsset ? "ETH" : network.tokenSymbol,
      decimals: 18,
    },
    rpcUrls: [network.rpcUrl],
  };
  const terms = describeTerms(built, network);
  const rows = Object.entries(terms)
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Review &amp; sign</title>
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
<button id="sign">Connect wallet &amp; sign</button>
<div id="status"></div>
<script>
const TYPED_DATA = ${JSON.stringify(typedData)};
const WALLET_CHAIN = ${JSON.stringify(walletChain)};
const status = (m) => { document.getElementById("status").textContent = m; };
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
    status("Check your wallet: review the SettlementIntent and sign...");
    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(TYPED_DATA)],
    });
    const res = await fetch(location.pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature, address }),
    });
    const body = await res.json();
    status(res.ok ? "Signed. You can close this tab — the agent is taking it from here." : "Rejected: " + body.error);
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

  private entry(id: string): { entry?: PendingHandoff; error?: string } {
    const entry = this.pending.get(id);
    if (!entry) return { error: "unknown handoff id" };
    if (entry.used) return { error: "this signing link was already used" };
    if (Date.now() > entry.expiresAt) return { error: "this signing link has expired" };
    return { entry };
  }

  private routes(): void {
    this.app.get<{ Params: { id: string } }>("/sign/:id", async (req, reply) => {
      const { entry, error } = this.entry(req.params.id);
      if (!entry) return reply.code(410).type("text/html").send(`<p>${error}</p>`);
      return reply
        .type("text/html")
        .send(pageHtml(req.params.id, entry.built, entry.explanation, this.network));
    });

    this.app.post<{ Params: { id: string }; Body: { signature?: string; address?: string } }>(
      "/sign/:id",
      async (req, reply) => {
        const { entry, error } = this.entry(req.params.id);
        if (!entry) return reply.code(410).send({ error });

        const { signature, address } = req.body ?? {};
        if (!signature || !address || !ethers.isAddress(address)) {
          return reply.code(400).send({ error: "signature and address are required" });
        }

        // Verify against the SDK's exact domain/types/value — same data the wallet displayed.
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

        entry.used = true; // single-use: burn before resolving
        const envelope: CryptographicEnvelopeV1 = {
          payerAddress: recovered,
          envelopeSignature: signature,
          intent: entry.built.intent,
          mode: entry.built.mode,
          metadata: entry.built.metadata,
        };
        const signed: SignedHandoff = {
          handoffId: req.params.id,
          signerAddress: recovered,
          signature,
          envelopeToken: serializeEnvelope(envelope),
        };
        entry.resolve(signed);
        return reply.send({ ok: true, signer: recovered });
      },
    );
  }

  async start(): Promise<string> {
    const port = this.opts.port ?? 8787;
    await this.app.listen({ port, host: "127.0.0.1" });
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  /** Register an intent for signing. Returns the one-time URL and a promise for the signature. */
  createHandoff(built: BuiltIntent, explanation: string): { id: string; url: string; signed: Promise<SignedHandoff> } {
    const id = randomBytes(16).toString("hex");
    const ttl = (this.opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    let resolve!: (s: SignedHandoff) => void;
    let reject!: (e: Error) => void;
    const signed = new Promise<SignedHandoff>((res, rej) => ((resolve = res), (reject = rej)));
    const entry: PendingHandoff = { built, explanation, expiresAt: Date.now() + ttl, used: false, resolve, reject, signed };
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

  async stop(): Promise<void> {
    await this.app.close();
  }
}
