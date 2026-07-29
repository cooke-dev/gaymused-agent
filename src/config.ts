// config.ts: owns ALL network values (chain, RPC, hub, token) and env keys; nothing else may hardcode them.
import * as dotenv from "dotenv";

dotenv.config();

export interface NetworkConfig {
  /** Preset name, e.g. "giwa-testnet". */
  name: string;
  chainId: number;
  /** Standard GIWA RPC. Default for all reads and submissions. */
  rpcUrl: string;
  /** Low-latency Flashblocks RPC. Opt-in via OPENRAILS_FLASHBLOCKS_RPC_URL, never the default. */
  flashblocksRpcUrl: string;
  /** OpenRails clearinghouse (hub) address, the Vault that enforces bounds. */
  hubAddress: string;
  /** ERC-20 settlement token (orUSD) the Vault escrows, meters, and enforces limits on. */
  tokenAddress: string;
  tokenSymbol: string;
  /** Fallback only; the reader reads the live value from the token contract and overrides it. */
  tokenDecimals: number;
  /** EIP-712 domain version the hub expects. */
  domainVersion: string;
  /** OpenRails keeper relay. Not deployed on GIWA yet: left empty so the loop uses the direct path. */
  relayUrl: string;
  /** Block explorer base for tx links in chat. */
  explorerBaseUrl: string;
}

// GIWA Sepolia is the only network. Gas is native ETH; the payment token (orUSD) is a standard
// ERC-20 the Vault escrows and meters, two separate assets. Values default to the confirmed GIWA
// deployment and can be overridden per field via the OPENRAILS_* env keys.
const GIWA_TESTNET: NetworkConfig = {
  name: "giwa-testnet",
  chainId: 91342,
  rpcUrl: "https://sepolia-rpc.giwa.io",
  flashblocksRpcUrl: "https://sepolia-rpc-flashblocks.giwa.io",
  hubAddress: "0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1",
  tokenAddress: "0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De",
  tokenSymbol: "orUSD",
  tokenDecimals: 6,
  domainVersion: "2.0.0",
  relayUrl: "", // no keeper relay on GIWA; the settlement loop opens directly against the hub
  explorerBaseUrl: "https://sepolia-explorer.giwa.io",
};

const PRESETS: Record<string, NetworkConfig> = {
  "giwa-testnet": GIWA_TESTNET,
};

export interface AppConfig {
  network: NetworkConfig;
  handoffHost: string;
  handoffPublicUrl?: string;
  /** Testnet payer key for the agent's own gas wallet; production users sign via the handoff, not this key. */
  payerPrivateKey?: string;
  openRouterApiKey?: string;
  /** OpenRouter model id for the brain, swappable without code changes. */
  openRouterModel: string;
  telegramBotToken?: string;
}

/** Load config: pick the GIWA preset, apply env overrides, attach secrets. */
export function loadConfig(): AppConfig {
  const presetName = process.env.OPENRAILS_NETWORK ?? "giwa-testnet";
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
    flashblocksRpcUrl: process.env.OPENRAILS_FLASHBLOCKS_RPC_URL ?? preset.flashblocksRpcUrl,
    hubAddress: process.env.OPENRAILS_HUB_ADDRESS ?? preset.hubAddress,
    tokenAddress: process.env.OPENRAILS_TOKEN_ADDRESS ?? preset.tokenAddress,
    relayUrl: process.env.OPENRAILS_RELAY_URL ?? preset.relayUrl,
    explorerBaseUrl: process.env.OPENRAILS_EXPLORER_BASE_URL ?? preset.explorerBaseUrl,
  };

  for (const field of ["chainId", "rpcUrl", "hubAddress", "tokenAddress"] as const) {
    if (!network[field]) {
      throw new Error(`Network "${network.name}" is missing ${field}, set the OPENRAILS_* env override.`);
    }
  }

  return {
    network,
    handoffHost: process.env.OPENRAILS_HANDOFF_HOST || "127.0.0.1",
    handoffPublicUrl: process.env.OPENRAILS_HANDOFF_PUBLIC_URL || undefined,
    payerPrivateKey: process.env.OPENRAILS_PAYER_PRIVATE_KEY || undefined,
    openRouterApiKey: process.env.OPENROUTER_API_KEY || undefined,
    openRouterModel: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  };
}
