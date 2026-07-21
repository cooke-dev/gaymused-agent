// try-brain.ts — run sample requests through the brain against real on-chain state. Prints proposals only; nothing is signed or submitted.
import { ethers } from "ethers";
import { loadConfig } from "../config";
import { makeProvider, readOnChainState } from "../reader";
import { decide } from "../brain";

const SAMPLES = [
  "Pay 0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5 0.5 USDC per hour for the next 6 hours, cap it at 3 USDC.",
  "Send 100 USDC to 0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5 right now.",
  "What's my balance, and do I have any streams open?",
  "Swap half my USDC into ETH please.",
];

async function main() {
  const cfg = loadConfig();
  if (!cfg.openRouterApiKey) {
    console.error("Set OPENROUTER_API_KEY in .env first.");
    process.exit(1);
  }
  if (!cfg.payerPrivateKey) {
    console.error("Set OPENRAILS_PAYER_PRIVATE_KEY in .env first.");
    process.exit(1);
  }

  const address = new ethers.Wallet(cfg.payerPrivateKey).address;
  const provider = makeProvider(cfg.network);
  console.log(`Reading on-chain state for ${address} on ${cfg.network.name}...`);
  const state = await readOnChainState(provider, cfg.network, address);
  console.log(`Model: ${cfg.openRouterModel}\n`);

  const requests = process.argv.length > 2 ? [process.argv.slice(2).join(" ")] : SAMPLES;
  for (const request of requests) {
    console.log("=".repeat(80));
    console.log(`USER: ${request}\n`);
    let attempts = 0;
    const rejections: string[] = [];
    const proposal = await decide(state, request, {
      apiKey: cfg.openRouterApiKey,
      model: cfg.openRouterModel,
      onAttempt: (n, rejected) => {
        attempts = n;
        if (rejected) rejections.push(`attempt ${n}: ${rejected.slice(0, 120)}`);
      },
    });
    console.log(`attempts:  ${attempts}${rejections.length ? `  REJECTIONS: ${rejections.join(" | ")}` : " (valid on first try)"}`);
    console.log(`action:    ${proposal.action}`);
    console.log(`feasible:  ${proposal.feasible}${proposal.reason ? `  (${proposal.reason})` : ""}`);
    if (proposal.payment) {
      const p = proposal.payment;
      console.log(`terms:     cap ${p.totalAllocation} ${p.token} → ${p.recipient}`);
      if (p.rate) console.log(`           rate ${p.rate.amount} ${p.token}/${p.rate.per}, duration ${p.durationSeconds}s`);
    }
    if (proposal.answer) console.log(`answer:    ${proposal.answer}`);
    console.log(`\nEXPLANATION:\n${proposal.explanation}\n`);
  }
}

main().catch((err) => {
  console.error("try-brain failed:", err);
  process.exit(1);
});
