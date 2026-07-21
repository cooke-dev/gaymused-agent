// config.ts — owns ALL network values (chain, RPC, hub, token) and env keys; nothing else may hardcode them.
import * as dotenv from "dotenv";

dotenv.config();

export interface NetworkConfig {
  /** Preset name, e.g. "arc-testnet-v2". */
  name: string;
  chainId: number;
  rpcUrl: string;
  /** OpenRails clearinghouse (hub) address — the Vault that enforces bounds. */
  hubAddress: string;
  /** Stablecoin settled by the rail (USDC). Native gas token on Arc; plain ERC-20 on GIWA. */
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** EIP-712 domain version the hub expects. */
  domainVersion: string;
  /** True where gas is NOT the stablecoin (GIWA: gas is ETH) — gasless relaying is then essential. */
  gasIsSeparateAsset: boolean;
  /** OpenRails keeper relay — sponsors gas for opens/claims (payGasless/claimGasless). */
  relayUrl: string;
  /** Block explorer base for tx links in chat. */
  explorerBaseUrl: string;
}

const PRESETS: Record<string, NetworkConfig> = {
  // LEGACY / reference only — proved the rail in component 1. GIWA is the target;
  // do not add Arc-specific behavior anywhere.
  "arc-testnet-v2": {
    name: "arc-testnet-v2",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    hubAddress: "0x941C8029F0f912df3fAb7423890ab2359b996D0b", // V2 canonical hub
    tokenAddress: "0x3600000000000000000000000000000000000000",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    domainVersion: "2.0.0",
    gasIsSeparateAsset: false,
    relayUrl: "https://openrails-reconciliation-worker.microcosm.workers.dev",
    explorerBaseUrl: "https://testnet.arcscan.app",
  },
  // Placeholder: filled from env the day Jason hands over the GIWA hub. Swapping
  // networks must remain this one config change.
  "giwa-testnet": {
    name: "giwa-testnet",
    chainId: Number(process.env.OPENRAILS_CHAIN_ID ?? 0),
    rpcUrl: process.env.OPENRAILS_RPC_URL ?? "",
    hubAddress: process.env.OPENRAILS_HUB_ADDRESS ?? "",
    tokenAddress: process.env.OPENRAILS_TOKEN_ADDRESS ?? "",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    domainVersion: "2.0.0",
    gasIsSeparateAsset: true,
    relayUrl: process.env.OPENRAILS_RELAY_URL ?? "",
    explorerBaseUrl: process.env.OPENRAILS_EXPLORER_BASE_URL ?? "",
  },
};

export interface AppConfig {
  network: NetworkConfig;
  /** Testnet payer key for dev; production users sign via the handoff, not this key. */
  payerPrivateKey?: string;
  openRouterApiKey?: string;
  /** OpenRouter model id for the brain — swappable without code changes. */
  openRouterModel: string;
  telegramBotToken?: string;
}

/** Load config: pick a network preset, apply env overrides, attach secrets. */
export function loadConfig(): AppConfig {
  const presetName = process.env.OPENRAILS_NETWORK ?? "arc-testnet-v2";
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown OPENRAILS_NETWORK "${presetName}". Known: ${Object.keys(PRESETS).join(", ")}`,
    );
  }

  const network: NetworkConfig = {
    ...preset,
    chainId: process.env.OPENRAILS_CHAIN_ID ? Number(process.env.OPENRAILS_CHAIN_ID) : preset.chainId,
    rpcUrl: process.env.OPENRAILS_RPC_URL ?? preset.rpcUrl,
    hubAddress: process.env.OPENRAILS_HUB_ADDRESS ?? preset.hubAddress,
    tokenAddress: process.env.OPENRAILS_TOKEN_ADDRESS ?? preset.tokenAddress,
  };

  for (const field of ["chainId", "rpcUrl", "hubAddress", "tokenAddress"] as const) {
    if (!network[field]) {
      throw new Error(`Network "${network.name}" is missing ${field} — set the OPENRAILS_* env override.`);
    }
  }

  return {
    network,
    payerPrivateKey: process.env.OPENRAILS_PAYER_PRIVATE_KEY || undefined,
    openRouterApiKey: process.env.OPENROUTER_API_KEY || undefined,
    openRouterModel: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  };
}
