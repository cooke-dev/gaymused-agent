// telegram.ts: a minimal, dependency-free Telegram Bot API client (long-poll getUpdates + sendMessage),
// hand-rolled over fetch in the same style as the OpenRouter call in brain.ts. No message logic here;
// this only moves text in and out of Telegram.

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramClient {
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await res.json()) as TgResponse<T>;
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result as T;
  }

  /** Confirm the token and return the bot's own username. */
  async getMe(): Promise<{ id: number; username: string }> {
    return this.call("getMe", {});
  }

  /**
   * Long-poll for new updates. Blocks up to timeoutSeconds on the server side; the client aborts a
   * little later so a dropped connection cannot hang the loop forever.
   */
  async getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]> {
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), (timeoutSeconds + 10) * 1000);
    try {
      return await this.call<TgUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
        controller.signal,
      );
    } finally {
      clearTimeout(guard);
    }
  }

  /** Send a plain-text message. Link previews are disabled so the local signing URL stays compact. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  }
}
