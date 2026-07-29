// telegram-supervisor.ts: keeps the Telegram sidecar alive after crashes or unexpected exits.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const entry = resolve(process.cwd(), "src/scripts/telegram-sidecar.ts");
const tsx = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
let child: ChildProcess | undefined;
let stopping = false;
let restartTimer: NodeJS.Timeout | undefined;
let delayMs = 1000;

function shutdown(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  child?.kill("SIGTERM");
}

function launch(): void {
  if (stopping) return;
  console.log("Starting Telegram sidecar.");
  child = spawn(process.execPath, [tsx, entry], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  child.once("error", (err) => console.error(`Telegram sidecar process error: ${err.message}`));
  child.once("exit", (code, signal) => {
    child = undefined;
    if (stopping) return;
    console.error(`Telegram sidecar exited (code ${code ?? "none"}, signal ${signal ?? "none"}). Restarting.`);
    restartTimer = setTimeout(launch, delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
launch();
