// actions.ts: the agent's action surface. Submits an already signed envelope to the Vault via the
// direct hub path and settles within bounds. Never signs an authorization: the user's signature is
// the authority, this layer only carries it to the chain. Escrow is pulled under a standard ERC-20
// allowance the payer set with approve(); the deployed orUSD has no EIP-2612 permit, so there is no
// gasless open on GIWA yet. GIWA also has no keeper relay, so the direct path is what the loop uses.
import { ethers } from "ethers";
import {
  RelayClient,
  submitOpenPaycardWithSigner,
  submitSettleWithSigner,
  readPaycard,
  readTokenAllowance,
  type PaycardView,
} from "openrails-sdk";
import type { NetworkConfig } from "./config";

export type OpenPath = "relay-gasless" | "hub-direct";

export type ActionOutcome =
  | {
      ok: true;
      txHash: string;
      paycardId: string;
      path: OpenPath;
      blockNumber?: number;
    }
  | { ok: false; blockedBy: "vault" | "relay" | "allowance"; reason: string; detail?: string };

export type SettleOutcome =
  | { ok: true; txHash: string; blockNumber?: number; settledAmount: string }
  | { ok: false; blockedBy: "vault"; reason: string; detail?: string };

/**
 * Custom-error selectors the hub reverts with. OPENRAILS_HUB_ABI declares no `error` fragments, so
 * ethers cannot decode these and surfaces mojibake like `execution reverted: X)6D`. These five are
 * the hub's declared custom errors; the selectors are keccak of each signature in the deployed hub
 * source, so the mapping is authoritative rather than inferred.
 */
const HUB_ERROR_SELECTORS: Record<string, string> = {
  // AccessViolation(): a signed field was mutated, so the recovered signer is not authorized for the
  // submitted terms. This is what the over-bounds "inflate the cap" attempt trips.
  "0x755b5e94": "vault rejected the authorization: signed terms do not match what was submitted",
  // CryptographicCollision(): the paycard id or nonce is already used. This is what a replay trips.
  "0x58293644": "vault rejected the replay: this signed intent was already used",
  // TimeWindowClosed(): opened at or after genesisTimestamp + lifespanSeconds, the stream window is shut.
  "0x5de6fba5": "the stream's signed time window has already closed",
  // BalanceExhausted(): the payer cannot fund the escrow (balance or allowance short of the pool).
  "0xd3159c24": "the payer cannot fund the escrow: balance or allowance is short of the cap",
  // InvalidIntent(): the intent parameters are self-inconsistent (e.g. a stream with zero velocity).
  "0x7db5cbbe": "the intent parameters are invalid",
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
 * Open a Paycard Stream gaslessly: a keeper relay pays gas, escrow is pulled from the payer under
 * the allowance they set, so the user needs no ETH for the open itself.
 *
 * DOCUMENTED FOLLOW-UP, not used by the current loop. GIWA has no keeper relay deployed yet, so
 * relayUrl is left unset and this returns "no relay configured" immediately. The settlement loop
 * uses openViaHub. Wire relayUrl and re-test this path if and when a GIWA relay is deployed.
 */
export async function openViaRelay(
  envelopeToken: string,
  network: NetworkConfig,
): Promise<ActionOutcome> {
  if (!network.relayUrl) {
    return { ok: false, blockedBy: "relay", reason: "no relay configured for this network" };
  }
  const relay = new RelayClient({ baseUrl: network.relayUrl });
  try {
    const res = await relay.relayOpen({ envelopeToken });
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
 * The hub funds escrow with `transferFrom` on the payer, so the payer must already have an allowance
 * to the hub at least as large as the pool or the open reverts with "transferFrom failed". The
 * deployed orUSD is a plain ERC-20 with no EIP-2612 permit, so that allowance is established by a
 * standard approve() the payer sends from their own wallet before the open. When the caller passes
 * the pool and payer, this checks the allowance first and returns a clear allowance-blocked result
 * instead of a cryptic revert. This layer signs no authorization of its own.
 */
export async function openViaHub(
  envelopeToken: string,
  submitter: ethers.Signer,
  network: NetworkConfig,
  options: { pool?: bigint | string; payer?: string } = {},
): Promise<ActionOutcome> {
  const shortfall = await requireAllowance(submitter, network, options);
  if (shortfall) return shortfall;

  try {
    const tx = await submitOpenPaycardWithSigner(submitter, network.hubAddress, envelopeToken, "railsflow");
    const receipt = await tx.wait();
    return {
      ok: true,
      txHash: tx.hash,
      paycardId: "",
      path: "hub-direct",
      blockNumber: receipt?.blockNumber,
    };
  } catch (err) {
    const { reason, detail } = revertReason(err);
    return { ok: false, blockedBy: "vault", reason, detail };
  }
}

/**
 * Confirm the payer's standing approve() allowance to the hub covers the pool before opening. Polls
 * briefly so a just-mined approve() is picked up despite RPC lag. Returns an allowance-blocked
 * outcome when the allowance never reaches the pool, or undefined when the caller gave no pool/payer
 * to check (the over-bounds and replay attempts, which the Vault must reject on their own terms).
 */
async function requireAllowance(
  submitter: ethers.Signer,
  network: NetworkConfig,
  options: { pool?: bigint | string; payer?: string },
): Promise<{ ok: false; blockedBy: "allowance"; reason: string } | undefined> {
  if (options.pool === undefined || !options.payer) return undefined;
  const provider = submitter.provider;
  if (!provider) return undefined;

  const need = BigInt(options.pool);
  const read = () => readTokenAllowance(provider, network.tokenAddress, options.payer!, network.hubAddress);
  let allowance = await read();
  for (let i = 0; i < 5 && allowance < need; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    allowance = await read();
  }
  if (allowance < need) {
    return {
      ok: false,
      blockedBy: "allowance",
      reason:
        `payer ${options.payer} has approved ${allowance} to the vault but the stream needs ${need}. ` +
        "Send approve() to the hub for at least the cap from the payer wallet, then retry.",
    };
  }
  return undefined;
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
