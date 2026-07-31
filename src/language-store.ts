import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Language } from "./i18n";

const STORE_PATH = resolve(process.cwd(), "data/telegram-languages.json");

export class LanguageStore {
  private readonly values = new Map<number, Language>();

  constructor() {
    try {
      const raw = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Record<string, Language>;
      for (const [chatId, language] of Object.entries(raw)) {
        if (language === "en" || language === "ko") this.values.set(Number(chatId), language);
      }
    } catch {
      // A missing or invalid local preference file uses English defaults.
    }
  }

  get(chatId: number): Language {
    return this.values.get(chatId) ?? "en";
  }

  has(chatId: number): boolean {
    return this.values.has(chatId);
  }

  set(chatId: number, language: Language): void {
    this.values.set(chatId, language);
    try {
      mkdirSync(dirname(STORE_PATH), { recursive: true });
      const output: Record<string, Language> = {};
      for (const [id, value] of this.values) output[String(id)] = value;
      writeFileSync(STORE_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
    } catch {
      // The in-memory value remains active if local persistence is unavailable.
    }
  }
}
