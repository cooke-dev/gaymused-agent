// actions.ts: the agent's action surface. Submits an already signed envelope to the Vault (gasless
// relay first, direct hub submission as fallback) and settles within bounds. Never signs an
// authorization: the user's signature is the authority, this layer only carries it to the chain.
import { ethers } from "ethers";
import {
  RelayClient,
  submitOpenPaycardWithSigner,
  submitSettleWithSigner,
  readPaycard,
  readTokenAllowance,
  type UsdcPermit,
  type PaycardView,
} from "openrails-sdk";
import type { NetworkConfig } from "./config";

export type OpenPath = "relay-gasless" | "hub-direct";

// EIP-2612. The SDK's ERC-20 fragment stops at approve/allowance, so the permit call is declared
// here. Submitting a permit relays the owner's signature; it does not create authority.
const ERC20_PERMIT_ABI = [
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
];

export type ActionOutcome =
  | {
      ok: true;
      txHash: string;
      paycardId: string;
      path: OpenPath;
      blockNumber?: number;
      /** Set when the hub path had to submit the user's permit before opening. */
      permitTxHash?: string;
    }
  | { ok: false; blockedBy: "vault" | "relay"; reason: string; detail?: string };

export type SettleOutcome =
  | { ok: true; txHash: string; blockNumber?: number; settledAmount: string }
  | { ok: false; blockedBy: "vault"; reason: string; detail?: string };

/**
 * Custom-error selectors the hub reverts with. OPENRAILS_HUB_ABI declares no `error` fragments, so
 * ethers cannot decode these and surfaces mojibake like `execution reverted: X)6D`.
 *
 * 0x755b5e94 is not decoded from a known signature: a keccak sweep of plausible names did not match
 * it, and the hub source is not in this repo. The label below is what it was observed to MEAN on
 * arc-testnet-v2, established by differential testing: it fires when any signed field is mutated
 * (inflated cap, altered nonce) and does NOT fire on an untampered intent, which instead proceeds
 * to the funding step. Treat the name as behavioural, not authoritative, and re-verify on GIWA.
 */
const HUB_ERROR_SELECTORS: Record<string, string> = {
  "0x755b5e94": "vault rejected the authorization: signed terms do not match what was submitted",
};

function selectorOf(err: unknown): string | undefined {
  const data = (err as { data?: unknown; info?: { error?: { data?: unknown } } })?.data
    ?? (err as { info?: { error?: { data?: unknown } } })?.info?.error?.data;
  return typeof data === "string" && /^0x[0-9a-fA-F]{8}$/.test(data.slice(0, 10))
    ? data.slice(0, 10).toLowerCase()
    : undefined;
}

/** Pull the most specific revert reason ethers surfaces, without leaking a wall of JSON. */
export function revertReason(err: unknown): { reason: string; detail?: string } {
  const e = err as {
    shortMessage?: string;
    reason?: string;
    message?: string;
    info?: { error?: { message?: string } };
  };

  // A known custom error beats ethers' undecodable rendering of the same revert.
  const selector = selectorOf(err);
  if (selector && HUB_ERROR_SELECTORS[selector]) {
    return { reason: HUB_ERROR_SELECTORS[selector], detail: `hub custom error ${selector}` };
  }

  const reason =
    e?.reason ??
    e?.info?.error?.message ??
    e?.shortMessage ??
    e?.message ??
    String(err);
  const detail = e?.shortMessage && e.shortMessage !== reason ? e.shortMessage : undefined;
  return { reason: String(reason).slice(0, 300), detail: selector ? `hub custom error ${selector}` : detail };
}

/**
 * Open a Paycard Stream gaslessly: the keeper relay pays gas, escrow is pulled from the recovered
 * payer per their signed intent. This is the GIWA native path (user needs no ETH).
 *
 * KNOWN EXTERNAL DEPENDENCY, not a bug in this codebase. As of 2026-07-22 the Arc testnet relay
 * fails here because its own upstream RPC (rpc.testnet.arc-node.thecanteenapp.com) returns 502 on
 * the relay's pre-flight check. It surfaces either as a clean "Open not currently valid: server
 * response 502 Bad Gateway" or, when the connection is cut mid-request, as a bare "fetch failed".
 * The relay itself is reachable and /relay-open is deployed. Callers must therefore treat this
 * path as best-effort and fall back to openViaHub, which is permit-aware and equivalent. Re-test
 * the gasless path against the GIWA relay before assuming it is broken there too.
 */
export async function openViaRelay(
  envelopeToken: string,
  permit: UsdcPermit | undefined,
  network: NetworkConfig,
): Promise<ActionOutcome> {
  if (!network.relayUrl) {
    return { ok: false, blockedBy: "relay", reason: "no relay configured for this network" };
  }
  const relay = new RelayClient({ baseUrl: network.relayUrl });
  try {
    const res = await relay.relayOpen({ envelopeToken, permit });
    return { ok: true, txHash: res.txHash, paycardId: res.paycardId, path: "relay-gasless" };
  } catch (err) {
    const { reason, detail } = revertReason(err);
    return { ok: false, blockedBy: "relay", reason, detail };
  }
}

/**
 * Open by submitting the signed envelope straight to the hub. The submitter pays gas but is not the
 * payer: the hub recovers the payer from the signature, so this account cannot redirect the money.
 *
 * The hub funds escrow with `transferFrom` on the payer, so the payer must have an allowance at
 * least as large as the pool or the open reverts with "SafeERC20: transferFrom failed". When the
 * allowance is short and the user signed a permit, submit that permit first. This keeps the direct
 * path equivalent to the relay path rather than quietly weaker: the permit is the USER's signature,
 * scoped to the value they approved, and the submitter only pays gas to carry it. This layer still
 * signs no authorization of its own.
 */
export async function openViaHub(
  envelopeToken: string,
  submitter: ethers.Signer,
  network: NetworkConfig,
  permit?: UsdcPermit,
  options: { pool?: bigint | string; payer?: string } = {},
): Promise<ActionOutcome> {
  const permitStep = await ensureAllowance(submitter, network, permit, options);
  if (permitStep && !permitStep.ok) return permitStep;

  try {
    const tx = await submitOpenPaycardWithSigner(submitter, network.hubAddress, envelopeToken, "railsflow");
    const receipt = await tx.wait();
    return {
      ok: true,
      txHash: tx.hash,
      paycardId: "",
      path: "hub-direct",
      blockNumber: receipt?.blockNumber,
      permitTxHash: permitStep?.ok ? permitStep.txHash : undefined,
    };
  } catch (err) {
    const { reason, detail } = revertReason(err);
    return { ok: false, blockedBy: "vault", reason, detail };
  }
}

/**
 * Submit the user's permit when, and only when, the existing allowance cannot cover the pool.
 * Returns undefined when no permit step was needed or possible.
 */
async function ensureAllowance(
  submitter: ethers.Signer,
  network: NetworkConfig,
  permit: UsdcPermit | undefined,
  options: { pool?: bigint | string; payer?: string },
): Promise<{ ok: true; txHash: string } | { ok: false; blockedBy: "vault"; reason: string; detail?: string } | undefined> {
  if (!permit || options.pool === undefined) return undefined;

  const owner = options.payer ?? permit.owner;
  const provider = submitter.provider;
  if (!provider) return undefined;

  const allowance = await readTokenAllowance(provider, network.tokenAddress, owner, network.hubAddress);
  if (allowance >= BigInt(options.pool)) return undefined; // already covered, do not spend gas

  try {
    const token = new ethers.Contract(network.tokenAddress, ERC20_PERMIT_ABI, submitter);
    const tx = await token.permit(
      permit.owner,
      permit.spender,
      permit.value,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
    );
    await tx.wait();
    return { ok: true, txHash: tx.hash };
  } catch (err) {
    const { reason, detail } = revertReason(err);
    return { ok: false, blockedBy: "vault", reason: `permit submission failed: ${reason}`, detail };
  }
}

/**
 * Settle accrued value to the recipient. Permissionless crank: it pays out only what the Vault has
 * metered so far, so it can never move more than the signed allocation.
 */
export async function settleStream(
  paycardId: string,
  submitter: ethers.Signer,
  network: NetworkConfig,
  provider: ethers.Provider,
): Promise<SettleOutcome> {
  const before = await readPaycard(provider, network.hubAddress, paycardId);
  try {
    const tx = await submitSettleWithSigner(submitter, network.hubAddress, paycardId);
    const receipt = await tx.wait();
    const after = await readPaycard(provider, network.hubAddress, paycardId);
    const settled = BigInt(before.availableBalance) - BigInt(after.availableBalance);
    return {
      ok: true,
      txHash: tx.hash,
      blockNumber: receipt?.blockNumber,
      settledAmount: settled.toString(),
    };
  } catch (err) {
    const { reason, detail } = revertReason(err);
    return { ok: false, blockedBy: "vault", reason, detail };
  }
}

/** Read a Paycard Stream row back from the Vault. */
export async function readStream(
  paycardId: string,
  network: NetworkConfig,
  provider: ethers.Provider,
): Promise<PaycardView> {
  return readPaycard(provider, network.hubAddress, paycardId);
}
