// print-state.ts: eyeball the reader: dump OnChainState for an address (default: the dev payer wallet).
import { ethers } from "ethers";
import { loadConfig } from "../config";
import { makeProvider, readOnChainState } from "../reader";

async function main() {
  const { network, payerPrivateKey } = loadConfig();
  const argAddress = process.argv[2];
  const address =
    argAddress ??
    (payerPrivateKey ? new ethers.Wallet(payerPrivateKey).address : undefined);
  if (!address) {
    console.error("Usage: tsx src/scripts/print-state.ts <address>  (or set OPENRAILS_PAYER_PRIVATE_KEY)");
    process.exit(1);
  }

  const provider = makeProvider(network);
  const state = await readOnChainState(provider, network, address);
  const fmt = (v: bigint) => ethers.formatUnits(v, state.tokenDecimals);

  console.log(`Network:   ${state.networkName} (chain ${state.chainId})`);
  console.log(`Address:   ${state.address}`);
  console.log(`Gas:       ${ethers.formatEther(state.gasBalance)} (native asset)`);
  console.log(`Token:     ${fmt(state.tokenBalance)} ${state.tokenSymbol} (${state.tokenDecimals} decimals)`);
  console.log(`Allowance: ${fmt(state.hubAllowance)} ${state.tokenSymbol} → hub`);
  console.log(`Lanes:     ${state.nonceLanes.map((l) => `lane ${l.lane} → next nonce ${l.nextValue}`).join(", ")}`);
  console.log(`Paycards:  ${state.paycards.length}`);
  for (const p of state.paycards) {
    console.log(`  - ${p.paycardId}`);
    console.log(`    ${p.kind} | ${p.status} | role: ${p.role}`);
    console.log(`    pool ${fmt(p.totalAllocationPool)} ${state.tokenSymbol}, remaining ${fmt(p.availableBalance)} ${state.tokenSymbol}`);
    console.log(`    velocity ${p.flowVelocityPerSecond}/s, lifespan ${p.lifespanSeconds}s from ${p.genesisTimestamp}`);
    console.log(`    payer ${p.payer} → recipient ${p.recipient}`);
    if (p.openedTxHash) console.log(`    opened in tx ${p.openedTxHash} (block ${p.openedBlockNumber})`);
  }
  console.log(`\nFetched at ${new Date(state.fetchedAt * 1000).toISOString()}`);
}

main().catch((err) => {
  console.error("print-state failed:", err);
  process.exit(1);
});
