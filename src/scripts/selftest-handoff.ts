// selftest-handoff.ts — offline QA of the handoff server mechanics (verify, single-use, bad-sig
// rejection) using an EPHEMERAL random wallet as a browser-wallet stand-in. No chain, no LLM, no .env key.
import { ethers } from "ethers";
import { OPENRAILS_EIP712_TYPES, buildSettlementIntentValue } from "openrails-sdk";
import { loadConfig } from "../config";
import { buildIntent } from "../intent-builder";
import { HandoffServer } from "../handoff";
import type { AgentProposal } from "../brain";
import type { OnChainState } from "../reader";

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  const { network } = loadConfig();
  const browserWallet = ethers.Wallet.createRandom(); // stand-in for the user's own wallet

  const state: OnChainState = {
    networkName: network.name,
    chainId: network.chainId,
    address: browserWallet.address,
    gasBalance: 0n,
    tokenBalance: 1_000_000n, // synthetic 1 USDC so the sample is feasible
    tokenDecimals: network.tokenDecimals,
    tokenSymbol: network.tokenSymbol,
    hubAllowance: 0n,
    paycards: [],
    nonceLanes: [{ lane: 0, nextValue: 0 }],
    fetchedAt: Math.floor(Date.now() / 1000),
  };
  const proposal: AgentProposal = {
    action: "open_one_time",
    feasible: true,
    payment: { token: network.tokenSymbol, recipient: "0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5", totalAllocation: "0.5" },
    explanation: "Self-test payment.",
  };

  const built = buildIntent(proposal, state, network);
  const server = new HandoffServer(network, { port: 8788, ttlSeconds: 60 });
  await server.start();
  const { url, signed } = server.createHandoff(built, proposal.explanation);

  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 1. Page renders with terms
  const page = await fetch(url).then((r) => r.text());
  check("GET page shows cap", page.includes("0.5 USDC"));
  check("GET page shows recipient", page.includes("0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5"));
  check("GET page embeds SDK typed data", page.includes("SettlementIntent"));

  // 2. Wrong signature rejected
  const badSig = await browserWallet.signMessage("wrong thing");
  const bad = await post(url, { signature: badSig, address: browserWallet.address });
  check("bad signature rejected", bad.status === 400, bad.json.error);

  // 3. Correct wallet-side signature accepted (signTypedData exactly as the page does)
  const signature = await browserWallet.signTypedData(
    built.domain,
    OPENRAILS_EIP712_TYPES,
    buildSettlementIntentValue(built.intent),
  );
  const good = await post(url, { signature, address: browserWallet.address });
  check("valid signature accepted", good.status === 200 && good.json.signer === browserWallet.address);

  const result = await signed;
  check("daemon received signature", result.signature === signature);
  check("recovered signer matches wallet", result.signerAddress === browserWallet.address);
  check("envelope token produced", result.envelopeToken.length > 100);

  // 4. Single-use: same link again must be dead
  const replay = await post(url, { signature, address: browserWallet.address });
  check("replay on used link rejected", replay.status === 410, replay.json.error);
  const pageAfter = await fetch(url);
  check("used link page returns 410", pageAfter.status === 410);

  await server.stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("selftest failed:", err);
  process.exit(1);
});
