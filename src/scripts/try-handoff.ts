// try-handoff.ts: end-to-end signing handoff test: build a real intent, open the page, user signs
// in their own browser wallet, verify the returned signature. No LLM calls, nothing submitted on-chain.
import { ethers } from "ethers";
import { loadConfig } from "../config";
import { makeProvider, readOnChainState } from "../reader";
import { buildIntent } from "../intent-builder";
import { HandoffServer } from "../handoff";
import type { AgentProposal } from "../brain";

async function main() {
  const cfg = loadConfig();

  // The wallet that will sign in the browser. Address only, this script never reads a private
  // key, and the .env dev key is deliberately not a fallback: real users sign in their own wallet.
  const signerAddress = process.argv[2];
  if (!signerAddress || !ethers.isAddress(signerAddress)) {
    console.error("Usage: tsx src/scripts/try-handoff.ts <wallet-address-you-will-sign-with>");
    process.exit(1);
  }

  const provider = makeProvider(cfg.network);
  console.log(`Reading fresh state for ${signerAddress}...`);
  const state = await readOnChainState(provider, cfg.network, signerAddress);

  // Hardcoded sample proposal, a tiny bounded stream (0.01 USDC/minute for 5 minutes, cap 0.05).
  const proposal: AgentProposal = {
    action: "open_stream",
    feasible: true,
    payment: {
      token: cfg.network.tokenSymbol,
      recipient: "0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5",
      totalAllocation: "0.05",
      rate: { amount: "0.01", per: "minute" },
      durationSeconds: 300,
    },
    explanation:
      "You are authorizing a small test stream: 0.01 USDC per minute for 5 minutes, hard-capped at " +
      "0.05 USDC. The funds sit in the on-chain Vault; the agent cannot exceed the cap, and anything " +
      "unused returns to you automatically.",
  };

  const ttlSeconds = 3600;
  const built = buildIntent(proposal, state, cfg.network);
  const server = new HandoffServer(cfg.network, { ttlSeconds });
  await server.start();
  const { url, signed } = server.createHandoff(built, proposal.explanation);

  console.log(`\nIntent built for payer ${signerAddress} (nonce lane 0, value ${state.nonceLanes[0]?.nextValue}).`);
  console.log("\nOpen this one-time link in the browser with your wallet and sign:");
  console.log(`\n  ${url}\n`);
  console.log(`Expires at ${new Date(Date.now() + ttlSeconds * 1000).toISOString()} (${ttlSeconds / 60} minutes).`);
  console.log("Waiting for the signature...");

  try {
    const result = await signed;
    console.log("\nSignature received and verified.");
    console.log(`  signer:      ${result.signerAddress}`);
    console.log(`  signature:   ${result.signature.slice(0, 24)}...${result.signature.slice(-10)}`);
    console.log(`  envelope:    ${result.envelopeToken.slice(0, 40)}... (${result.envelopeToken.length} chars, ready for component 6)`);
    const matches = result.signerAddress.toLowerCase() === signerAddress.toLowerCase();
    console.log(`  matches intended payer: ${matches ? "yes" : `NO, intent was built for ${signerAddress}`}`);
    console.log("\nNothing was submitted on-chain. Handoff proven.");
  } finally {
    await server.stop();
  }
}

main().catch((err) => {
  console.error("try-handoff failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
