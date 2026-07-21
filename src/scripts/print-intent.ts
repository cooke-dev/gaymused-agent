// print-intent.ts: offline inspection of the intent-builder: hardcoded proposals + hardcoded state,
// zero LLM calls, zero chain calls. Prints the exact unsigned typed intents.
import { loadConfig } from "../config";
import { buildIntent } from "../intent-builder";
import type { AgentProposal } from "../brain";
import type { OnChainState } from "../reader";

// Synthetic state mirroring the real funded wallet (values copied from print-state output).
const state: OnChainState = {
  networkName: "arc-testnet-v2",
  chainId: 5042002,
  address: "0x0FBC60B5F91684Fa5f4E5f3B00795974EcE613CF",
  gasBalance: 19_931_919_397_000_000_000n,
  tokenBalance: 19_931_919n, // 19.931919 USDC
  tokenDecimals: 6,
  tokenSymbol: "USDC",
  hubAllowance: 0n,
  paycards: [],
  nonceLanes: [{ lane: 0, nextValue: 1 }],
  fetchedAt: 1_784_700_000,
};

const streamProposal: AgentProposal = {
  action: "open_stream",
  feasible: true,
  payment: {
    token: "USDC",
    recipient: "0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5",
    totalAllocation: "3",
    rate: { amount: "0.5", per: "hour" },
    durationSeconds: 21600,
  },
  explanation: "Stream 0.5 USDC/hour for 6 hours, capped at 3 USDC.",
};

const oneTimeProposal: AgentProposal = {
  action: "open_one_time",
  feasible: true,
  payment: {
    token: "USDC",
    recipient: "0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5",
    totalAllocation: "1.25",
  },
  explanation: "One-time payment of 1.25 USDC.",
};

const infeasibleProposal: AgentProposal = {
  action: "open_one_time",
  feasible: false,
  reason: "cap exceeds balance",
  payment: { token: "USDC", recipient: "0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5", totalAllocation: "100" },
  explanation: "Should never be built.",
};

function show(label: string, fn: () => unknown) {
  console.log("=".repeat(80));
  console.log(label);
  console.log("=".repeat(80));
  try {
    console.log(JSON.stringify(fn(), null, 2));
  } catch (err) {
    console.log(`REJECTED: ${err instanceof Error ? err.message : err}`);
  }
  console.log();
}

const { network } = loadConfig();
const nowSeconds = 1_784_700_000; // fixed for reproducible output

show("STREAM proposal → unsigned intent", () =>
  buildIntent(streamProposal, state, network, { nowSeconds }),
);
show("ONE-TIME proposal → unsigned intent", () =>
  buildIntent(oneTimeProposal, state, network, { nowSeconds }),
);
show("INFEASIBLE proposal → must be rejected", () =>
  buildIntent(infeasibleProposal, state, network, { nowSeconds }),
);
