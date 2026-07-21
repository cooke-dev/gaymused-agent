// handoff.ts: signing handoff. Serves human readable terms for a BuiltIntent, the user signs the
// SDK's exact typed data (intent + optional EIP-2612 permit) in their OWN browser wallet, and only
// signatures return. The daemon never sees, requests, or stores a key.
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import {
  OPENRAILS_EIP712_TYPES,
  buildSettlementIntentValue,
  serializeEnvelope,
  signUsdcPermit,
  type CryptographicEnvelopeV1,
  type UsdcPermit,
} from "openrails-sdk";
import type { BuiltIntent } from "./intent-builder";
import type { NetworkConfig } from "./config";

/** EIP-712 payload for an EIP-2612 permit, built by the SDK and signed in the browser. */
export interface PermitTypedData {
  domain: ethers.TypedDataDomain;
  types: Record<string, ethers.TypedDataField[]>;
  message: Record<string, unknown>;
  owner: string;
  spender: string;
  value: string;
  deadline: number;
}

export interface SignedHandoff {
  handoffId: string;
  signerAddress: string;
  signature: string;
  /** Serialized CryptographicEnvelopeV1, exactly what the relay or hub consumes. */
  envelopeToken: string;
  /** Present when a permit was requested and signed. Lets the open run gasless. */
  permit?: UsdcPermit;
}

interface PendingHandoff {
  built: BuiltIntent;
  explanation: string;
  permit?: PermitTypedData;
  expiresAt: number;
  used: boolean;
  resolve: (signed: SignedHandoff) => void;
  reject: (err: Error) => void;
}

const DEFAULT_TTL_SECONDS = 600;
// Structurally valid throwaway signature so the SDK's Signature.from() parses during capture.
const DUMMY_SIGNATURE = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";

/**
 * Produce the permit EIP-712 payload without signing it, by handing the SDK a capturing account.
 * This keeps permit construction inside openrails-sdk instead of hand rolling EIP-2612.
 */
export async function buildPermitTypedData(params: {
  owner: string;
  token: string;
  spender: string;
  value: bigint | string;
  chainId: number;
  provider: ethers.Provider;
  deadline?: number;
}): Promise<PermitTypedData> {
  let captured: { domain: ethers.TypedDataDomain; types: Record<string, ethers.TypedDataField[]>; message: Record<string, unknown> } | undefined;

  const capturingAccount = {
    getAddress: async () => params.owner,
    signTypedData: async (
      domain: ethers.TypedDataDomain,
      types: Record<string, ethers.TypedDataField[]>,
      value: Record<string, unknown>,
    ) => {
      captured = { domain, types, message: value };
      return DUMMY_SIGNATURE;
    },
  };

  const shell = await signUsdcPermit(capturingAccount, {
    token: params.token,
    spender: params.spender,
    value: params.value,
    chainId: params.chainId,
    provider: params.provider,
    deadline: params.deadline,
  });
  if (!captured) throw new Error("permit typed data was not captured");

  return {
    domain: captured.domain,
    types: captured.types,
    message: captured.message,
    owner: shell.owner,
    spender: shell.spender,
    value: shell.value,
    deadline: shell.deadline,
  };
}

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

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function pageHtml(entry: PendingHandoff, network: NetworkConfig): string {
  const { built, explanation, permit } = entry;
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
  const permitTypedData = permit
    ? {
        types: { EIP712Domain: eip712Domain, ...permit.types },
        primaryType: "Permit",
        domain: permit.domain,
        message: jsonSafe(permit.message),
      }
    : null;
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
  const rows = Object.entries(describeTerms(built, network))
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");
  const permitNote = permit
    ? `<p><strong>Two signatures.</strong> The first authorizes the payment terms. The second is a
       spending permit for exactly ${ethers.formatUnits(permit.value, network.tokenDecimals)}
       ${network.tokenSymbol}, which lets the payment open without you paying any gas. Both are
       signatures only, neither is a transaction.</p>`
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
${permitNote}
<button id="sign">Connect wallet and sign</button>
<div id="status"></div>
<script>
const INTENT_DATA = ${JSON.stringify(intentTypedData)};
const PERMIT_DATA = ${JSON.stringify(permitTypedData)};
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
    status("Signature 1 of " + (PERMIT_DATA ? "2" : "1") + ": review the payment terms in your wallet.");
    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(INTENT_DATA)],
    });
    let permitSignature = null;
    if (PERMIT_DATA) {
      status("Signature 2 of 2: approve the spending permit in your wallet.");
      permitSignature = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(PERMIT_DATA)],
      });
    }
    status("Sending signatures back to the agent...");
    const res = await fetch(location.pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature, address, permitSignature }),
    });
    const body = await res.json();
    status(res.ok ? "Signed. You can close this tab, the agent is taking it from here." : "Rejected: " + body.error);
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
      Body: { signature?: string; address?: string; permitSignature?: string | null };
    }>("/sign/:id", async (req, reply) => {
      const { entry, error } = this.lookup(req.params.id);
      if (!entry) return reply.code(410).send({ error });

      const { signature, address, permitSignature } = req.body ?? {};
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

      let permit: UsdcPermit | undefined;
      if (entry.permit) {
        if (!permitSignature) return reply.code(400).send({ error: "permit signature is required" });
        let permitSigner: string;
        try {
          permitSigner = ethers.verifyTypedData(
            entry.permit.domain,
            entry.permit.types,
            entry.permit.message,
            permitSignature,
          );
        } catch {
          return reply.code(400).send({ error: "permit signature does not verify" });
        }
        if (permitSigner.toLowerCase() !== recovered.toLowerCase()) {
          return reply.code(400).send({ error: "permit was signed by a different address than the intent" });
        }
        const { v, r, s } = ethers.Signature.from(permitSignature);
        permit = {
          owner: entry.permit.owner,
          spender: entry.permit.spender,
          value: entry.permit.value,
          deadline: entry.permit.deadline,
          v,
          r,
          s,
        };
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
        permit,
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

  /** Register an intent for signing. Returns the one-time URL and a promise for the signatures. */
  createHandoff(
    built: BuiltIntent,
    explanation: string,
    permit?: PermitTypedData,
  ): { id: string; url: string; signed: Promise<SignedHandoff> } {
    const id = randomBytes(16).toString("hex");
    const ttl = (this.opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    let resolve!: (s: SignedHandoff) => void;
    let reject!: (e: Error) => void;
    const signed = new Promise<SignedHandoff>((res, rej) => ((resolve = res), (reject = rej)));
    const entry: PendingHandoff = {
      built,
      explanation,
      permit,
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

  async stop(): Promise<void> {
    await this.app.close();
  }
}
