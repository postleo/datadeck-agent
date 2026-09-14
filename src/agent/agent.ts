// ─────────────────────────────────────────────────────────────
// DataDeck Agent — the Strands agent (conversational Pro Agent)
// Built per the Strands Agents TypeScript SDK docs.
//
// Provider-agnostic. Pick with DATADECK_PROVIDER:
//   • "google" (default) — Gemini via a free Google AI Studio key
//     (GEMINI_API_KEY). Model defaults to gemini-2.5-flash.
//   • "bedrock" — Amazon Nova (a first-party FOUNDATION model) via a
//     cross-region INFERENCE PROFILE, on Amazon Bedrock (needs AWS creds).
//     Newer Bedrock models are inference-profile-only, so pass a profile id
//     (e.g. "us.amazon.nova-lite-v1:0"), NOT a bare model id. Prefer
//     foundation models over AWS Marketplace models. Anthropic Claude also
//     works ("us.anthropic.claude-*"), but first-time use may require a
//     one-time use-case form in the Bedrock console.
//
// NOTE: this conversational layer needs a model + credentials. The
// deterministic cleaning pipeline (src/core) needs neither.
// ─────────────────────────────────────────────────────────────
import { Agent, BedrockModel, type Model } from '@strands-agents/sdk';
import { GoogleModel } from '@strands-agents/sdk/models/google';
import { dataDeckTools } from '../tools/index';
import { SYSTEM_PROMPT } from './systemPrompt';

export type Provider = 'google' | 'bedrock';

/** Sensible per-provider defaults. */
const DEFAULTS = {
  google: { modelId: 'gemini-2.5-flash' },
  // A first-party foundation model via a cross-region inference profile (works
  // account-wide without a use-case form or Marketplace enablement).
  bedrock: { modelId: 'us.amazon.nova-lite-v1:0', region: 'us-east-1' },
} as const;

export interface CreateAgentOptions {
  /** "google" (Gemini) or "bedrock". Defaults to env DATADECK_PROVIDER or "google". */
  provider?: Provider;
  /** Override the model id (defaults to env DATADECK_MODEL_ID or the provider default). */
  modelId?: string;
  /** Bedrock only: AWS region (defaults to env DATADECK_REGION or us-east-1). */
  region?: string;
  /** Google only: API key (defaults to env GEMINI_API_KEY / GOOGLE_API_KEY). */
  apiKey?: string;
  /** Print the agent's reasoning to the console (default true). */
  printer?: boolean;
  temperature?: number;
  /** Override the toolset (defaults to the standard DataDeck cleaning tools). */
  tools?: unknown[];
  /** Override the system prompt (defaults to the standard cleaning prompt). */
  systemPrompt?: string;
}

function buildModel(options: CreateAgentOptions): Model {
  const provider: Provider = options.provider ?? (process.env.DATADECK_PROVIDER as Provider) ?? 'google';
  const modelId = options.modelId ?? process.env.DATADECK_MODEL_ID;

  if (provider === 'bedrock') {
    const region = options.region ?? process.env.DATADECK_REGION ?? DEFAULTS.bedrock.region;
    return new BedrockModel({
      modelId: modelId ?? DEFAULTS.bedrock.modelId,
      region,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });
  }

  // Google / Gemini (default). apiKey falls back to GEMINI_API_KEY / GOOGLE_API_KEY.
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return new GoogleModel({
    ...(apiKey ? { apiKey } : {}),
    modelId: modelId ?? DEFAULTS.google.modelId,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
}

/** Build a DataDeck Pro Agent wired to the cleaning tools. */
export function createAgent(options: CreateAgentOptions = {}): Agent {
  return new Agent({
    model: buildModel(options),
    tools: (options.tools as typeof dataDeckTools) ?? dataDeckTools,
    systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
    printer: options.printer ?? true,
  });
}

/** Pull the plain text out of an agent's final Message (joins text blocks). */
export function messageText(lastMessage: unknown): string {
  if (!lastMessage) return '';
  if (typeof lastMessage === 'string') return lastMessage;
  const content = (lastMessage as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return String(lastMessage);
}

/** Convenience: run a single prompt and return the agent's final text. */
export async function ask(prompt: string, options: CreateAgentOptions = {}): Promise<string> {
  const agent = createAgent({ ...options, printer: options.printer ?? false });
  const result = await agent.invoke(prompt);
  return messageText(result.lastMessage);
}
