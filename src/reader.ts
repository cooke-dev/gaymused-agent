// reader.ts: read-only on-chain state for the agent: gas + token balances, existing Paycard Streams, Nonce Lanes. No LLM, no writes.
import { ethers } from "ethers";
import {
  readNonce,
  readTokenBalance,
  readTokenAllowance,
  readPaycard,
  recoverPaycardsFromLogs,
  getOpenRailsToken,
  type RecoveredPaycard,
} from "openrails-sdk";
import type { NetworkConfig } from "./config";

/** Provider tuned for public RPCs: pinned chain, no request batching (rate limits). */
export function makeProvider(network: NetworkConfig): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(network.rpcUrl, network.chainId, {
    staticNetwork: ethers.Network.from(network.chainId),
    batchMaxCount: 1,
  });
}

export interface PaycardSummary {
  paycardId: string;
  /** How this address relates to the card. */
  role: "payer" | "recipient" | "both";
  status: "Active" | "Terminated";
  /** lifespanSeconds === 0 → one-time card; otherwise a metered stream (MCP's own rule). */
  kind: "one-time" | "streaming";
  payer: string;
  recipient: string;
  totalAllocationPool: bigint;
  /** Remaining allocation still escrowed in the Vault row. */
  availableBalance: bigint;
  flowVelocityPerSecond: bigint;
  genesisTimestamp: number;
  lifespanSeconds: number;
  residualDeltaRecipient: string;
  openedTxHash?: string;
  openedBlockNumber?: number;
}

export interface NonceLaneState {
  lane: number;
  /** Next nonce value the hub expects on this lane, use as `nonceValue` in a new intent. */
  nextValue: number;
}

export interface OnChainState {
  networkName: string;
  chainId: number;
  address: string;
  /** Native gas asset balance in wei-equivalent (ETH on GIWA; NOT assumed to be the stablecoin). */
  gasBalance: bigint;
  /** Stablecoin ERC-20 balance of the configured demo token. */
  tokenBalance: bigint;
  /** Decimals read from the token contract (config fallback), never assumed. */
  tokenDecimals: number;
  tokenSymbol: string;
  /** Current ERC-20 allowance from this address to the hub (approve-path headroom). */
  hubAllowance: bigint;
  /** Existing paycards/streams where this address is payer or recipient. */
  paycards: PaycardSummary[];
  /** Nonce Lane state needed to build the next intent. */
  nonceLanes: NonceLaneState[];
  fetchedAt: number;
}

export interface ReadStateOptions {
  /** How many recent blocks to scan for PaycardProvisioned events (default 50_000). */
  lookbackBlocks?: number;
  /** Max paycards to return per role scan (default 25). */
  limit?: number;
  /** Nonce Lanes to read (default [0], the lane the MCP uses). */
  lanes?: number[];
  /** Known paycard ids to include even if outside the log lookback window. */
  knownPaycardIds?: string[];
  /**
   * Enumerate existing paycards by scanning event logs (default true). Set false on hot paths that
   * only need balances and nonce lanes: the scan is the slowest call and public RPCs time out on it.
   */
  includePaycards?: boolean;
}

function summarize(
  card: Pick<RecoveredPaycard, "paycardId" | "registry"> & Partial<Pick<RecoveredPaycard, "provisioned">>,
  address: string,
): PaycardSummary {
  const addr = address.toLowerCase();
  const isPayer = card.registry.payer.toLowerCase() === addr;
  const isRecipient = card.registry.recipient.toLowerCase() === addr;
  return {
    paycardId: card.paycardId,
    role: isPayer && isRecipient ? "both" : isPayer ? "payer" : "recipient",
    status: card.registry.operationalStatus,
    kind: card.registry.lifespanSeconds === 0 ? "one-time" : "streaming",
    payer: card.registry.payer,
    recipient: card.registry.recipient,
    totalAllocationPool: BigInt(card.registry.totalAllocationPool),
    availableBalance: BigInt(card.registry.availableBalance),
    flowVelocityPerSecond: BigInt(card.registry.flowVelocityPerSecond),
    genesisTimestamp: card.registry.genesisTimestamp,
    lifespanSeconds: card.registry.lifespanSeconds,
    residualDeltaRecipient: card.registry.residualDeltaRecipient,
    openedTxHash: card.provisioned?.transactionHash,
    openedBlockNumber: card.provisioned?.blockNumber,
  };
}

/** Read the complete on-chain state for one address. Deterministic; safe to call anytime. */
export async function readOnChainState(
  provider: ethers.Provider,
  network: NetworkConfig,
  address: string,
  options: ReadStateOptions = {},
): Promise<OnChainState> {
  const user = ethers.getAddress(address);
  const lanes = options.lanes ?? [0];
  const lookbackBlocks = options.lookbackBlocks ?? 50_000;
  const limit = options.limit ?? 25;

  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

  // Gas and stablecoin are distinct assets (only legacy Arc conflates them), read both.
  const gasBalance = await provider.getBalance(user);
  const tokenBalance = await readTokenBalance(provider, network.tokenAddress, user);
  const hubAllowance = await readTokenAllowance(provider, network.tokenAddress, user, network.hubAddress);

  let tokenDecimals = network.tokenDecimals;
  try {
    tokenDecimals = Number(await getOpenRailsToken(provider, network.tokenAddress).decimals());
  } catch {
    // token without decimals(), keep the config fallback
  }

  const byId = new Map<string, PaycardSummary>();
  if (options.includePaycards !== false) {
    const asPayer = await recoverPaycardsFromLogs(provider, network.hubAddress, {
      payer: user,
      fromBlock,
      toBlock: latestBlock,
      limit,
    });
    const asRecipient = await recoverPaycardsFromLogs(provider, network.hubAddress, {
      recipient: user,
      fromBlock,
      toBlock: latestBlock,
      limit,
    });
    for (const card of [...asPayer, ...asRecipient]) {
      byId.set(card.paycardId.toLowerCase(), summarize(card, user));
    }
  }
  // Pinned ids (e.g. from our audit log) may predate the lookback window, read them directly.
  for (const id of options.knownPaycardIds ?? []) {
    if (byId.has(id.toLowerCase())) continue;
    const registry = await readPaycard(provider, network.hubAddress, id);
    if (registry.payer === ethers.ZeroAddress) continue;
    byId.set(id.toLowerCase(), summarize({ paycardId: id, registry }, user));
  }

  const nonceLanes: NonceLaneState[] = [];
  for (const lane of lanes) {
    nonceLanes.push({ lane, nextValue: await readNonce(provider, network.hubAddress, user, lane) });
  }

  return {
    networkName: network.name,
    chainId: network.chainId,
    address: user,
    gasBalance,
    tokenBalance,
    tokenDecimals,
    tokenSymbol: network.tokenSymbol,
    hubAllowance,
    paycards: [...byId.values()].sort((a, b) => (b.openedBlockNumber ?? 0) - (a.openedBlockNumber ?? 0)),
    nonceLanes,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
