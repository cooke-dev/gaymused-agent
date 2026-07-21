// intent-builder.ts: deterministically converts a feasible brain proposal into the exact unsigned
// OpenRails intent the Vault will enforce. No LLM, no signing, no submission, no I/O.
import { ethers } from "ethers";
import {
  createRailsFlowIntent,
  createInstantSettlementIntent,
  hashOpenRailsMetadata,
  buildMetadataBoundPaycardId,
  buildOpenRailsDomain,
  type CanonicalMetadataV1,
  type OpenRailsIntentV1,
} from "openrails-sdk";
import type { AgentProposal } from "./brain";
import type { OnChainState } from "./reader";
import type { NetworkConfig } from "./config";

const PERIOD_SECONDS: Record<string, bigint> = {
  minute: 60n,
  hour: 3600n,
  day: 86400n,
  week: 604800n,
};

/** Everything component 5 needs to present terms and collect the user's signature. */
export interface BuiltIntent {
  /** Unsigned intent in the SDK's exact signing type, ready for signPermissionEnvelope. */
  intent: OpenRailsIntentV1;
  /** Canonical metadata committed to by intent.metadataHash. */
  metadata: CanonicalMetadataV1;
  metadataHash: string;
  mode: "railsflow";
  /** EIP-712 domain the signature must target (version from config, built by the SDK). */
  domain: ethers.TypedDataDomain;
  /** Base units actually enforced, for display/audit alongside the human terms. */
  baseUnits: {
    totalAllocationPool: string;
    flowVelocityPerSecond: string;
  };
}

export class IntentBuildError extends Error {}

/** Human decimal string → base units. parseUnits rejects excess precision; we also verify the round-trip. */
function toBaseUnits(human: string, decimals: number, label: string): bigint {
  let base: bigint;
  try {
    base = ethers.parseUnits(human, decimals);
  } catch {
    throw new IntentBuildError(`${label} "${human}" does not fit in ${decimals} decimals`);
  }
  const roundTrip = ethers.formatUnits(base, decimals);
  if (ethers.parseUnits(roundTrip, decimals) !== base) {
    throw new IntentBuildError(`${label} "${human}" failed round-trip conversion`);
  }
  return base;
}

/**
 * Build the unsigned typed intent from a feasible proposal.
 * Pure function: nonce and decimals come from the passed-in OnChainState, pass FRESH state,
 * read immediately before building, or the hub will reject the stale nonce.
 */
export function buildIntent(
  proposal: AgentProposal,
  state: OnChainState,
  network: NetworkConfig,
  options: { lane?: number; nowSeconds?: number } = {},
): BuiltIntent {
  if (!proposal.feasible) {
    throw new IntentBuildError(`refusing to build intent: proposal is not feasible (${proposal.reason ?? "no reason given"})`);
  }
  if (proposal.action !== "open_stream" && proposal.action !== "open_one_time") {
    throw new IntentBuildError(`refusing to build intent: action "${proposal.action}" is not a payment`);
  }
  const pay = proposal.payment;
  if (!pay) throw new IntentBuildError("refusing to build intent: proposal has no payment terms");
  if (pay.token !== state.tokenSymbol) {
    throw new IntentBuildError(`proposal token ${pay.token} does not match configured ${state.tokenSymbol}`);
  }
  const recipient = ethers.getAddress(pay.recipient); // throws on invalid
  const payer = ethers.getAddress(state.address);

  const decimals = state.tokenDecimals;
  const totalAllocationPool = toBaseUnits(pay.totalAllocation, decimals, "totalAllocation");
  if (totalAllocationPool <= 0n) throw new IntentBuildError("totalAllocation must be positive");
  if (totalAllocationPool > state.tokenBalance) {
    throw new IntentBuildError("totalAllocation exceeds current token balance");
  }

  let flowVelocityPerSecond = 0n;
  let lifespanSeconds = 0;
  if (proposal.action === "open_stream") {
    if (!pay.rate || !pay.durationSeconds) {
      throw new IntentBuildError("stream proposal must carry rate and durationSeconds");
    }
    lifespanSeconds = pay.durationSeconds;
    const ratePerPeriod = toBaseUnits(pay.rate.amount, decimals, "rate.amount");
    // Floor: metering never flows faster than the user's stated rate; any shortfall
    // stays in the pool and returns as residual. The cap is enforced by the pool either way.
    flowVelocityPerSecond = ratePerPeriod / PERIOD_SECONDS[pay.rate.per];
    if (flowVelocityPerSecond < 1n) {
      throw new IntentBuildError(
        `rate ${pay.rate.amount} ${pay.token}/${pay.rate.per} is below 1 base unit per second and cannot be metered`,
      );
    }
    if (flowVelocityPerSecond * BigInt(lifespanSeconds) > totalAllocationPool * 2n) {
      // Defense in depth; checkProposal already enforces rate*duration <= cap in human terms.
      throw new IntentBuildError("velocity times lifespan grossly exceeds the allocation cap");
    }
  }

  const lane = options.lane ?? 0; // Nonce Lane 0, same lane the MCP uses
  const laneState = state.nonceLanes.find((l) => l.lane === lane);
  if (!laneState) throw new IntentBuildError(`no Nonce Lane ${lane} state in OnChainState`);
  const nonceValue = laneState.nextValue;

  const metadata: CanonicalMetadataV1 = {
    version: "openrails-metadata-v1",
    mode: "railsflow",
    originator: payer,
    recipient,
    token: network.tokenAddress,
    amount: totalAllocationPool.toString(),
    flowVelocityPerSecond: flowVelocityPerSecond.toString(),
    lifespanSeconds,
    metadataRef: "gaymused-agent",
  };
  const metadataHash = hashOpenRailsMetadata(metadata);
  const paycardId = buildMetadataBoundPaycardId({ payer, nonceChannel: lane, nonceValue, metadataHash });

  const params: OpenRailsIntentV1 = {
    paycardId,
    metadataHash,
    recipient,
    totalAllocationPool: totalAllocationPool.toString(),
    flowVelocityPerSecond: flowVelocityPerSecond.toString(),
    genesisTimestamp: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    lifespanSeconds,
    residualDeltaRecipient: payer, // unused residual always returns to the payer
    nonceChannel: lane,
    nonceValue,
  };
  const intent =
    proposal.action === "open_stream"
      ? createRailsFlowIntent(params)
      : createInstantSettlementIntent(params);

  return {
    intent,
    metadata,
    metadataHash,
    mode: "railsflow",
    domain: buildOpenRailsDomain(network.chainId, network.hubAddress, network.domainVersion),
    baseUnits: {
      totalAllocationPool: totalAllocationPool.toString(),
      flowVelocityPerSecond: flowVelocityPerSecond.toString(),
    },
  };
}
