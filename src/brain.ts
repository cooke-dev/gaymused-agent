// brain.ts: DECIDES and EXPLAINS only. Consumes OnChainState + a user request, returns a validated
// human-terms proposal. Never signs, never builds typed data, never submits, never touches the chain.
import { ethers } from "ethers";
import { z } from "zod";
import type { OnChainState, PaycardSummary } from "./reader";

// ---------- proposal schema (the brain's ONLY output) ----------

const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a plain decimal number string, e.g. \"5\" or \"0.25\"");

const PaymentTermsSchema = z.object({
  /** Token symbol, always the configured demo token, never guessed. */
  token: z.string(),
  recipient: z.string(),
  /** Hard cap in human token units, the bound the Vault will enforce. */
  totalAllocation: decimalString,
  /** Streams only: human-readable rate. */
  rate: z
    .object({ amount: decimalString, per: z.enum(["minute", "hour", "day", "week"]) })
    .optional(),
  /** Streams only: total validity window in seconds. */
  durationSeconds: z.number().int().positive().optional(),
});

export const ProposalSchema = z.object({
  action: z.enum(["open_stream", "open_one_time", "answer_state", "unsupported"]),
  /** Required for open_* actions. null is tolerated and treated as absent (cheap models emit it). */
  payment: PaymentTermsSchema.nullish(),
  /** For answer_state: the answer, grounded in the provided state only. */
  answer: z.string().optional(),
  feasible: z.boolean(),
  /** Why it is not feasible / not supported. */
  reason: z.string().optional(),
  /** Plain-language description of exactly what would be authorized, for a non-technical user. */
  explanation: z.string().min(1),
});

export type AgentProposal = z.infer<typeof ProposalSchema>;
export type PaymentTerms = z.infer<typeof PaymentTermsSchema>;

export interface BrainOptions {
  apiKey: string;
  model: string;
  /** Max LLM attempts before giving up (schema-invalid responses are retried). */
  maxAttempts?: number;
  /** Instrumentation only: called per attempt; `rejected` is set when that attempt failed validation. */
  onAttempt?: (attempt: number, rejected?: string) => void;
}

// ---------- grounding ----------

const PERIOD_SECONDS: Record<string, number> = { minute: 60, hour: 3600, day: 86400, week: 604800 };

function fmtCard(c: PaycardSummary, decimals: number, symbol: string): string {
  return (
    `${c.kind} paycard ${c.paycardId.slice(0, 10)}... [${c.status}] as ${c.role}: ` +
    `cap ${ethers.formatUnits(c.totalAllocationPool, decimals)} ${symbol}, ` +
    `remaining ${ethers.formatUnits(c.availableBalance, decimals)} ${symbol}, ` +
    `recipient ${c.recipient}`
  );
}

/** Deterministic, human-units summary of the state the LLM is allowed to know. */
export function describeState(state: OnChainState): string {
  const d = state.tokenDecimals;
  const s = state.tokenSymbol;
  const lines = [
    `network: ${state.networkName} (chain ${state.chainId})`,
    `wallet: ${state.address}`,
    `${s} balance: ${ethers.formatUnits(state.tokenBalance, d)}`,
    `native gas balance: ${ethers.formatEther(state.gasBalance)}`,
    `paycards (${state.paycards.length}):`,
    ...state.paycards.map((c) => `  - ${fmtCard(c, d, s)}`),
  ];
  return lines.join("\n");
}

// ---------- prompt ----------

function systemPrompt(state: OnChainState): string {
  return `You are the decision brain of a bounded-payment copilot built on OpenRails.
A user asks in plain language; you DECIDE what bounded payment to propose and EXPLAIN it.
You never execute anything: downstream deterministic code converts your proposal into an
on-chain intent, the USER signs it, and the on-chain Vault enforces the bounds.

Classify the request as exactly one action:
- "open_stream": a metered payment over time (has a rate and a duration) with a hard total cap.
- "open_one_time": a single payment of a fixed amount.
- "answer_state": the user asks about their balances or existing paycards/streams.
- "unsupported": anything else (swaps, new tokens, canceling, multiple payments at once,
  anything ambiguous you cannot classify with confidence). Never guess.

Ground every number in the CURRENT ON-CHAIN STATE below. Never invent balances or paycards.
Feasibility: a proposal whose totalAllocation exceeds the ${state.tokenSymbol} balance is NOT feasible
(feasible=false, with the reason); still fill in the payment terms the user asked for.
The only token you may propose is ${state.tokenSymbol} (the configured token). If the user names another
token, the action is "unsupported".

Output rules:
- Respond with ONLY a JSON object, no prose around it.
- Omit unused optional keys entirely (e.g. no "payment" for answer_state/unsupported, no "rate" for
  one-time payments), never set a key to null.
- Amounts are human-readable decimal strings in ${state.tokenSymbol} units (e.g. "5", "0.25"), never
  base units, never hex. You never produce addresses not present in the request or state, never
  calldata, signatures, or transaction data.
- "recipient" must be copied verbatim from the user's request (a 0x... address). If the user gave
  no recipient address, the action is "unsupported" with a reason asking for the address.
- For "open_stream": include payment.rate {amount, per} and payment.durationSeconds, and
  totalAllocation as the hard cap. Cap must be >= rate * duration; if the user gave only a rate and
  duration, set totalAllocation = rate * duration exactly.
- For "open_one_time": include payment.totalAllocation only (no rate/duration).
- "explanation": 2-4 sentences for a non-technical user: what will be authorized, the exact bounds
  (cap, rate, duration), that the money is escrowed in a Vault the agent cannot exceed, and that
  unused funds return to them.
- "answer_state": put the answer in "answer", grounded strictly in the state; feasible=true.

JSON schema (informal):
{
  "action": "open_stream" | "open_one_time" | "answer_state" | "unsupported",
  "payment": { "token": "${state.tokenSymbol}", "recipient": "0x...", "totalAllocation": "5",
               "rate": { "amount": "1", "per": "minute"|"hour"|"day"|"week" }, "durationSeconds": 3600 },
  "answer": "...",
  "feasible": true|false,
  "reason": "...",
  "explanation": "..."
}

CURRENT ON-CHAIN STATE:
${describeState(state)}`;
}

// ---------- deterministic validation (LLM output is a proposal, not a command) ----------

function checkProposal(p: AgentProposal, state: OnChainState): AgentProposal {
  if (p.action !== "open_stream" && p.action !== "open_one_time") {
    return { ...p, payment: undefined }; // no payment terms on non-payment actions
  }

  const pay = p.payment;
  if (!pay) {
    return { ...p, action: "unsupported", feasible: false, reason: "proposal missing payment terms" };
  }
  const fail = (reason: string): AgentProposal => ({ ...p, feasible: false, reason });

  if (pay.token !== state.tokenSymbol) return fail(`only ${state.tokenSymbol} is supported`);
  if (!ethers.isAddress(pay.recipient)) return fail("recipient is not a valid address");
  if (pay.recipient.toLowerCase() === state.address.toLowerCase()) {
    return fail("recipient is the payer's own wallet");
  }

  let cap: bigint;
  try {
    cap = ethers.parseUnits(pay.totalAllocation, state.tokenDecimals);
  } catch {
    return fail(`amount "${pay.totalAllocation}" has more precision than ${state.tokenSymbol} supports`);
  }
  if (cap <= 0n) return fail("total allocation must be positive");
  if (cap > state.tokenBalance) {
    return fail(
      `cap of ${pay.totalAllocation} ${state.tokenSymbol} exceeds wallet balance of ` +
        `${ethers.formatUnits(state.tokenBalance, state.tokenDecimals)} ${state.tokenSymbol}`,
    );
  }

  if (p.action === "open_stream") {
    if (!pay.rate || !pay.durationSeconds) return fail("stream needs a rate and a duration");
    let ratePerPeriod: bigint;
    try {
      ratePerPeriod = ethers.parseUnits(pay.rate.amount, state.tokenDecimals);
    } catch {
      return fail(`rate "${pay.rate.amount}" has more precision than ${state.tokenSymbol} supports`);
    }
    const totalAtRate =
      (ratePerPeriod * BigInt(pay.durationSeconds)) / BigInt(PERIOD_SECONDS[pay.rate.per]);
    if (totalAtRate > cap) {
      return fail("rate times duration exceeds the proposed cap, bounds are inconsistent");
    }
  } else if (pay.rate || pay.durationSeconds) {
    return fail("one-time payment must not have a rate or duration");
  }

  return p;
}

// ---------- OpenRouter call ----------

async function callOpenRouter(opts: BrainOptions, system: string, user: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return content;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(trimmed);
}

/** Decide + explain. Returns a schema-validated, deterministically checked proposal. */
export async function decide(
  state: OnChainState,
  userRequest: string,
  opts: BrainOptions,
): Promise<AgentProposal> {
  const system = systemPrompt(state);
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const user = lastError
      ? `${userRequest}\n\n(Your previous response was rejected: ${lastError}. Respond again with ONLY valid JSON matching the schema.)`
      : userRequest;
    const raw = await callOpenRouter(opts, system, user);
    try {
      const parsed = ProposalSchema.parse(extractJson(raw));
      opts.onAttempt?.(attempt);
      return checkProposal(parsed, state);
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 400) : String(err);
      opts.onAttempt?.(attempt, lastError);
    }
  }
  throw new Error(`Brain produced no valid proposal after ${maxAttempts} attempts: ${lastError}`);
}
