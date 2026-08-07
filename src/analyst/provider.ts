import { config } from "../config.js";

// Zero-dependency Gemini REST client (PLAN.md §7.6): responseSchema is
// enforced server-side so we get well-formed JSON and only validate
// citations. Sequential callers + exponential backoff with jitter — no
// parallel fan-out, free-tier RPM limits are tight.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ATTEMPTS = 5;

export interface GenerateOptions {
  temperature?: number;
  model?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  error?: { message?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export const usage = { calls: 0, promptTokens: 0, outputTokens: 0 };

export async function generateJson<T>(
  prompt: string,
  responseSchema: object,
  opts: GenerateOptions = {},
): Promise<T> {
  if (!config.llm.apiKey) {
    throw new Error("GEMINI_API_KEY is not set — add it to .env (https://aistudio.google.com/apikey)");
  }
  const model = opts.model ?? config.llm.model;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: opts.temperature ?? 1.0,
      maxOutputTokens: config.llm.maxOutputTokens,
    },
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.llm.apiKey },
      body,
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Gemini ${res.status} after ${attempt} attempts`);
      }
      const backoff = Math.min(60_000, 2 ** attempt * 1000) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    const data = (await res.json()) as GeminiResponse;
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${data.error?.message ?? "unknown error"}`);
    }
    const candidate = data.candidates?.[0];
    // Thinking models interleave `thought` parts — only answer parts are JSON.
    const text = candidate?.content?.parts
      ?.filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    if (!text) {
      throw new Error(`Gemini returned no text (finishReason: ${candidate?.finishReason ?? "none"})`);
    }
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new Error("Gemini output truncated at maxOutputTokens — raise config.llm.maxOutputTokens");
    }
    usage.calls += 1;
    usage.promptTokens += data.usageMetadata?.promptTokenCount ?? 0;
    usage.outputTokens += data.usageMetadata?.candidatesTokenCount ?? 0;
    return JSON.parse(text) as T;
  }
}
