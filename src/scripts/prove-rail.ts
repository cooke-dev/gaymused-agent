// prove-rail.ts: one-shot proof that the live Arc-testnet-V2 rail works: open a tiny bounded stream, read it back.
import { ethers } from "ethers";
import {
  LeptonOpenRailsClient,
  createRailsFlowIntent,
  hashOpenRailsMetadata,
  buildMetadataBoundPaycardId,
  approveOpenRailsSpend,
  submitOpenPaycardWithSigner,
  readPaycard,
  readNonce,
  readTokenBalance,
  readTokenAllowance,
  assertOpenRailsNetwork,
  type CanonicalMetadataV1,
} from "openrails-sdk";
import { loadConfig } from "../config";

async function main() {
  const { network, payerPrivateKey } = loadConfig();
  console.log(`Network: ${network.name} (chain ${network.chainId})`);
  console.log(`Hub:     ${network.hubAddress}`);
  console.log(`Token:   ${network.tokenAddress} (${network.tokenSymbol})`);

  // Static network + no batching: the public Arc RPC rate-limits bursts hard.
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId, {
    staticNetwork: ethers.Network.from(network.chainId),
    batchMaxCount: 1,
  });
  await assertOpenRailsNetwork(provider, network.chainId);
  console.log(`RPC OK, connected to chain ${network.chainId}`);

  if (!payerPrivateKey) {
    const fresh = ethers.Wallet.createRandom();
    console.error(
      "\nNo OPENRAILS_PAYER_PRIVATE_KEY in .env. Generated a throwaway testnet key for you:\n" +
        `  address: ${fresh.address}\n` +
        "Add the key to .env as OPENRAILS_PAYER_PRIVATE_KEY, fund the address with Arc testnet USDC\n" +
        "(gas on Arc IS USDC), then rerun. Key printed only this once:\n" +
        `  ${fresh.privateKey}`,
    );
    process.exit(1);
  }

  const signer = new ethers.Wallet(payerPrivateKey, provider);
  const payer = await signer.getAddress();
  const balance = await readTokenBalance(provider, network.tokenAddress, payer);
  console.log(`Payer:   ${payer}`);
  console.log(`Balance: ${ethers.formatUnits(balance, network.tokenDecimals)} ${network.tokenSymbol}`);

  // Tiny bounded stream: 0.06 USDC total, metered over 10 minutes.
  const totalAllocationPool = 60_000n; // 0.06 USDC at 6 decimals
  const lifespanSeconds = 600;
  const flowVelocityPerSecond = totalAllocationPool / BigInt(lifespanSeconds); // 100/s, pool == velocity * lifespan

  if (balance < totalAllocationPool) {
    console.error(
      `\nInsufficient ${network.tokenSymbol}: need at least ` +
        `${ethers.formatUnits(totalAllocationPool, network.tokenDecimals)} plus gas. ` +
        "Fund the payer with Arc testnet USDC (e.g. faucet.circle.com → Arc Testnet) and rerun.",
    );
    process.exit(1);
  }

  const recipient = ethers.Wallet.createRandom().address; // throwaway demo recipient
  const nonceChannel = 0;
  const nonceValue = await readNonce(provider, network.hubAddress, payer, nonceChannel);
  console.log(`Nonce:   lane ${nonceChannel}, value ${nonceValue}`);

  const metadata: CanonicalMetadataV1 = {
    version: "openrails-metadata-v1",
    mode: "railsflow",
    originator: payer,
    recipient,
    token: network.tokenAddress,
    amount: totalAllocationPool.toString(),
    flowVelocityPerSecond: flowVelocityPerSecond.toString(),
    lifespanSeconds,
    workflowId: "prove-rail",
  };
  const metadataHash = hashOpenRailsMetadata(metadata);
  const paycardId = buildMetadataBoundPaycardId({ payer, nonceChannel, nonceValue, metadataHash });

  const intent = createRailsFlowIntent({
    paycardId,
    metadataHash,
    recipient,
    totalAllocationPool: totalAllocationPool.toString(),
    flowVelocityPerSecond: flowVelocityPerSecond.toString(),
    genesisTimestamp: Math.floor(Date.now() / 1000),
    lifespanSeconds,
    residualDeltaRecipient: payer,
    nonceChannel,
    nonceValue,
  });

  const allowance = await readTokenAllowance(provider, network.tokenAddress, payer, network.hubAddress);
  if (allowance < totalAllocationPool) {
    console.log("Approving hub to pull escrow...");
    const approveTx = await approveOpenRailsSpend(signer, network.tokenAddress, network.hubAddress, totalAllocationPool);
    await approveTx.wait();
    console.log(`Approved: ${approveTx.hash}`);
  }

  const client = new LeptonOpenRailsClient(
    payerPrivateKey,
    network.hubAddress,
    network.chainId,
    provider,
    undefined,
    network.domainVersion,
  );
  const envelopeToken = await client.signPermissionEnvelope(intent, { mode: "railsflow", metadata });
  console.log("Signed EIP-712 permission envelope.");

  const openTx = await submitOpenPaycardWithSigner(signer, network.hubAddress, envelopeToken, "railsflow");
  const receipt = await openTx.wait();
  console.log(`Stream opened: tx ${openTx.hash} (block ${receipt?.blockNumber})`);

  const view = await readPaycard(provider, network.hubAddress, paycardId);
  console.log("\nRead back from the Vault:");
  console.log(`  paycardId:  ${paycardId}`);
  console.log(`  payer:      ${view.payer}`);
  console.log(`  recipient:  ${view.recipient}`);
  console.log(`  pool:       ${ethers.formatUnits(view.totalAllocationPool, network.tokenDecimals)} ${network.tokenSymbol}`);
  console.log(`  velocity:   ${view.flowVelocityPerSecond} base-units/s`);
  console.log(`  lifespan:   ${view.lifespanSeconds}s from ${view.genesisTimestamp}`);
  console.log(`  status:     ${view.operationalStatus}`);
  console.log("\nRail proven: bounded stream opened on-chain and read back.");
}

main().catch((err) => {
  console.error("prove-rail failed:", err);
  process.exit(1);
});
