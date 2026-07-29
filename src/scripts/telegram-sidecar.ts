// telegram-sidecar.ts: entrypoint for the Telegram sidecar. Loads config, starts the long-lived
// handoff server and the bot, and keeps running until interrupted.
import { loadConfig } from "../config";
import { TelegramSidecar } from "../bot";

async function main() {
  const cfg = loadConfig();
  const sidecar = new TelegramSidecar(cfg);

  const shutdown = () => {
    console.log("\nShutting down sidecar...");
    sidecar.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await sidecar.start();
}

main().catch((err) => {
  console.error("sidecar failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
