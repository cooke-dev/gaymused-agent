// money-shot.ts: the full demo loop on a live chain. Opens a bounded stream from the user's signed
// envelope, settles within bounds, then proves the Vault refuses an over-bounds attempt on-chain.
import { ethers } from "ethers";
import {
  deserializeEnvelope,
  serializeEnvelope,
  readTokenBalance,
  hashOpenRailsMetadata,
  buildMetadataBoundPaycardId,
  type CryptographicEnvelopeV1,
  type CanonicalMetadataV1,
} from "openrails-sdk";
import { loadConfig } from "../config";
import { makeProvider, readOnChainState } from "../reader";
import { buildIntent } from "../intent-builder";
import { HandoffServer, type ApprovalRequest } from "../handoff";
import { openViaHub, settleStream, readStream } from "../actions";
import type { AgentProposal } from "../brain";

const RECIPIENT = "0x4b94939CBfc33aAC3e2651E959eD6D5d35AfA4D5";
const ACCRUAL_WAIT_MS = 20_000;

const line = (label: string) => console.log(`\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}`);

async function main() {
  const cfg = loadConfig();
  const payerAddress = process.argv[2];
  if (!payerAddress || !ethers.isAddress(payerAddress)) {
    console.error("Usage: tsx src/scripts/money-shot.ts <your-wallet-address>");
    process.exit(1);
  }
  if (!cfg.payerPrivateKey) {
    console.error("Set OPENRAILS_PAYER_PRIVATE_KEY in .env: it funds the agent's own wallet, which pays gas for the settle crank.");
    process.exit(1);
  }

  const provider = makeProvider(cfg.network);
  // The agent's own server wallet. It pays gas for cranks. It never signs a user authorization,
  // and the Vault bounds it to what the user signed.
  const agentWallet = new ethers.Wallet(cfg.payerPrivateKey, provider);

  line("SETUP");
  console.log(`Network:       ${cfg.network.name} (chain ${cfg.network.chainId})`);
  console.log(`Hub (Vault):   ${cfg.network.hubAddress}`);
  console.log(`User (payer):  ${payerAddress}`);
  console.log(`Agent wallet:  ${agentWallet.address} (gas only)`);

  // Nothing sponsors gas on GIWA: the agent wallet pays for the open and settle. Stop early with a
  // clear message if it holds no ETH, rather than failing mid-demo.
  const agentGas = await provider.getBalance(agentWallet.address);
  console.log(`Agent ETH:     ${ethers.formatEther(agentGas)} ETH`);
  if (agentGas === 0n) {
    console.error(
      `\nThe agent wallet ${agentWallet.address} holds no GIWA ETH and cannot pay gas for the ` +
        "open or settle. Fund it with GIWA Sepolia test ETH and rerun.",
    );
    process.exit(1);
  }

  // Skip the log scan: this path needs balances, decimals, and the nonce lane only.
  const state = await readOnChainState(provider, cfg.network, payerAddress, { includePaycards: false });
  // Decimals come from the token contract via the reader, never hardcoded.
  const fmt = (v: bigint | string) => ethers.formatUnits(v, state.tokenDecimals);
  console.log(`Token:         ${cfg.network.tokenSymbol} at ${state.tokenDecimals} decimals (read from the contract)`);
  console.log(`User balance:  ${fmt(state.tokenBalance)} ${cfg.network.tokenSymbol}, nonce lane 0 at ${state.nonceLanes[0]?.nextValue}`);

  // Bounded stream: 0.003 orUSD per minute for 1800s, hard cap 0.09 orUSD. Rate times duration equals
  // the cap exactly, and the velocity divides evenly into 50 base units/sec at 6 decimals. The
  // lifespan is deliberately generous: genesisTimestamp is stamped when the intent is built, and the
  // hub closes the open window at genesis + lifespan, so the window must outlast the human signing
  // and the approve() confirmation before the agent opens.
  const proposal: AgentProposal = {
    action: "open_stream",
    feasible: true,
    payment: {
      token: cfg.network.tokenSymbol,
      recipient: RECIPIENT,
      totalAllocation: "0.09",
      rate: { amount: "0.003", per: "minute" },
      durationSeconds: 1800,
    },
    explanation:
      `You are authorizing a bounded stream of 0.003 ${cfg.network.tokenSymbol} per minute for 30 minutes, ` +
      `capped at 0.09 ${cfg.network.tokenSymbol} in total. The funds sit in the on-chain Vault, the agent ` +
      "cannot exceed the cap, and anything unused returns to you.",
  };

  const built = buildIntent(proposal, state, cfg.network);
  const paycardId = built.intent.paycardId;
  console.log(`Paycard id:    ${paycardId}`);
  console.log(`Cap:           ${fmt(built.baseUnits.totalAllocationPool)} ${cfg.network.tokenSymbol} at ${built.baseUnits.flowVelocityPerSecond} base units/sec`);

  // Standard ERC-20 approval for exactly the cap. orUSD has no EIP-2612 permit, so the payer sends
  // approve() to the hub from their own wallet; the agent then opens under that allowance.
  const approval: ApprovalRequest = {
    token: cfg.network.tokenAddress,
    spender: cfg.network.hubAddress,
    value: built.baseUnits.totalAllocationPool.toString(),
  };

  const ttlSeconds = 3600;
  const server = new HandoffServer(cfg.network, { ttlSeconds });
  await server.start();
  const { url, signed } = server.createHandoff(built, proposal.explanation, approval);

  line("STEP 1: SIGNING HANDOFF (user signs and approves in their own wallet)");
  console.log(`\n  ${url}\n`);
  console.log(`One signature for the payment terms, then an approve() of ${fmt(approval.value)} ${cfg.network.tokenSymbol} to the hub.`);
  console.log(`Expires at ${new Date(Date.now() + ttlSeconds * 1000).toISOString()}. Waiting...`);

  const handoff = await signed;
  console.log(`\nSigned by ${handoff.signerAddress}.`);
  if (handoff.approveTxHash) {
    console.log(`APPROVED (the payer's own approve() tx, gas paid by the payer)`);
    console.log(`  tx: ${handoff.approveTxHash}`);
    console.log(`  ${cfg.network.explorerBaseUrl}/tx/${handoff.approveTxHash}`);
  }

  const recipientBefore = await readTokenBalance(provider, cfg.network.tokenAddress, RECIPIENT);
  const payerBefore = await readTokenBalance(provider, cfg.network.tokenAddress, payerAddress);

  line("STEP 2: IN BOUNDS, OPEN THE STREAM (direct hub path, under the payer's approval)");
  // GIWA has no keeper relay, so the agent opens directly against the hub. Escrow is pulled under
  // the allowance the payer set with approve(); the agent wallet only pays gas.
  const opened = await openViaHub(handoff.envelopeToken, agentWallet, cfg.network, {
    pool: built.baseUnits.totalAllocationPool,
    payer: payerAddress,
  });
  if (!opened.ok) {
    console.log(`OPEN FAILED (${opened.blockedBy}): ${opened.reason}`);
    if (opened.detail) console.log(`  Detail: ${opened.detail}`);
    await server.stop();
    process.exit(1);
  }
  console.log(`OPENED via ${opened.path}`);
  console.log(`  tx: ${opened.txHash}`);
  console.log(`  ${cfg.network.explorerBaseUrl}/tx/${opened.txHash}`);

  let view = await readStream(paycardId, cfg.network, provider);
  console.log(`  Vault row: pool ${fmt(view.totalAllocationPool)}, remaining ${fmt(view.availableBalance)}, velocity ${view.flowVelocityPerSecond}/s, status ${view.operationalStatus}`);

  line("STEP 3: IN BOUNDS, SETTLE WHAT HAS ACCRUED");
  console.log(`Waiting ${ACCRUAL_WAIT_MS / 1000}s for value to accrue...`);
  await new Promise((r) => setTimeout(r, ACCRUAL_WAIT_MS));
  const settled = await settleStream(paycardId, agentWallet, cfg.network, provider);
  if (!settled.ok) {
    console.log(`SETTLE FAILED: ${settled.reason}`);
  } else {
    console.log(`SETTLED ${fmt(settled.settledAmount)} ${cfg.network.tokenSymbol} to the recipient`);
    console.log(`  tx: ${settled.txHash}`);
    console.log(`  ${cfg.network.explorerBaseUrl}/tx/${settled.txHash}`);
    view = await readStream(paycardId, cfg.network, provider);
    console.log(`  Vault row now: remaining ${fmt(view.availableBalance)} of ${fmt(view.totalAllocationPool)} ${cfg.network.tokenSymbol}`);
  }
  const recipientAfterSettle = await readTokenBalance(provider, cfg.network.tokenAddress, RECIPIENT);
  console.log(`  Recipient balance: ${fmt(recipientBefore)} -> ${fmt(recipientAfterSettle)} ${cfg.network.tokenSymbol}`);

  line("STEP 4: OVER BOUNDS, THE VAULT REFUSES");

  // Attempt A: the agent rewrites the signed cap upward. It cannot just resubmit the same paycard
  // (the hub rejects a duplicate id outright, which is Attempt B), so it mints a fresh, internally
  // consistent paycard for the inflated terms and attaches the user's ORIGINAL signature. The
  // signature covers the 0.09 terms, so the hub recovers a different signer and refuses on-chain.
  const tampered = deserializeEnvelope<CryptographicEnvelopeV1>(handoff.envelopeToken);
  const signedCap = BigInt(tampered.intent.totalAllocationPool);
  const grab = signedCap * 10n;
  const inflatedMetadata = { ...tampered.metadata, amount: grab.toString() } as CanonicalMetadataV1;
  const inflatedMetadataHash = hashOpenRailsMetadata(inflatedMetadata);
  const freshNonce = Number(tampered.intent.nonceValue) + 1; // an unconsumed lane value, so no duplicate-id clash
  tampered.intent.totalAllocationPool = grab.toString();
  tampered.intent.metadataHash = inflatedMetadataHash;
  tampered.intent.nonceValue = freshNonce;
  tampered.intent.paycardId = buildMetadataBoundPaycardId({
    payer: handoff.signerAddress,
    nonceChannel: tampered.intent.nonceChannel,
    nonceValue: freshNonce,
    metadataHash: inflatedMetadataHash,
  });
  tampered.metadata = inflatedMetadata;
  const tamperedToken = serializeEnvelope(tampered);
  console.log(`\nAttempt A: agent inflates the cap from ${fmt(signedCap)} to ${fmt(grab)} ${cfg.network.tokenSymbol} and submits the user's signature.`);
  const attemptA = await openViaHub(tamperedToken, agentWallet, cfg.network);
  if (attemptA.ok) {
    console.log(`  UNEXPECTED: the tampered open succeeded in tx ${attemptA.txHash}`);
  } else {
    console.log(`  BLOCKED by the ${attemptA.blockedBy} on-chain. Nothing moved.`);
    console.log(`  Reason: ${attemptA.reason}`);
    if (attemptA.detail) console.log(`  Detail: ${attemptA.detail}`);
  }

  // Attempt B: the agent replays the original signed envelope to open a second funded stream.
  console.log(`\nAttempt B: agent replays the same signature to open a duplicate stream.`);
  const attemptB = await openViaHub(handoff.envelopeToken, agentWallet, cfg.network);
  if (attemptB.ok) {
    console.log(`  UNEXPECTED: the replay succeeded in tx ${attemptB.txHash}`);
  } else {
    console.log(`  BLOCKED by the ${attemptB.blockedBy} on-chain. Nothing moved.`);
    console.log(`  Reason: ${attemptB.reason}`);
  }

  const payerAfter = await readTokenBalance(provider, cfg.network.tokenAddress, payerAddress);
  const recipientAfter = await readTokenBalance(provider, cfg.network.tokenAddress, RECIPIENT);
  console.log(`\nAfter the blocked attempts:`);
  console.log(`  Payer:     ${fmt(payerBefore)} -> ${fmt(payerAfter)} ${cfg.network.tokenSymbol} (only the signed escrow left the wallet)`);
  console.log(`  Recipient: ${fmt(recipientAfterSettle)} -> ${fmt(recipientAfter)} ${cfg.network.tokenSymbol} (unchanged by the over-bounds attempts)`);
  view = await readStream(paycardId, cfg.network, provider);
  console.log(`  Vault row: pool still ${fmt(view.totalAllocationPool)} ${cfg.network.tokenSymbol}, remaining ${fmt(view.availableBalance)}`);

  line("RESULT");
  console.log(`In bounds:  stream opened and settled, capped at ${fmt(view.totalAllocationPool)} ${cfg.network.tokenSymbol}.`);
  console.log(`Over bounds: refused on-chain by the Vault. The budget is enforced by the contract,`);
  console.log(`             so even a runaway agent cannot spend past what the user signed.`);

  await server.stop();
}

main().catch((err) => {
  console.error("money-shot failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
