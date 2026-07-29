/**
 * Shared AWS Bedrock client (Anthropic Messages API via InvokeModel).
 *
 * Created for the Insights reporting agent. Mirrors the client construction,
 * model IDs, and Sonnet→Haiku fallback of server/referral/extract.ts, but adds
 * generic message/tool-use support and an explicit request timeout (the
 * extractor has none — flagged in the investigation).
 *
 * NOTE: server/referral/extract.ts is intentionally NOT migrated to use this
 * module yet — that's a separate follow-up. This module is agent-only for now.
 *
 * No PHI concern here: callers decide what goes in `system`/`messages`. The
 * reporting agent sends only its schema/date-rules prompt + chat text.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Cross-region inference profiles, us-east-1 fronted (same as extract.ts).
const PRIMARY_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const FALLBACK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface BedrockMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InvokeOptions {
  tools?: unknown[];
  toolChoice?: unknown; // e.g. { type: "tool", name: "respond" }
  maxTokens?: number;
  timeoutMs?: number;
}

/** The parsed Anthropic response body (content blocks incl. tool_use). */
export interface BedrockResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >;
  stop_reason?: string;
  [k: string]: unknown;
}

async function invokeOne(
  modelId: string,
  system: string,
  messages: BedrockMessage[],
  opts: InvokeOptions,
): Promise<BedrockResponse> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: opts.maxTokens ?? 1024,
    system,
    messages,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const command = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    });
    const response = await client.send(command, { abortSignal: controller.signal });
    return JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Invoke the primary model, falling back to Haiku only on model
 * access/availability errors (same rule as extract.ts). Network/timeout/other
 * errors propagate to the caller.
 */
export async function invokeMessages(
  system: string,
  messages: BedrockMessage[],
  opts: InvokeOptions = {},
): Promise<BedrockResponse> {
  try {
    return await invokeOne(PRIMARY_MODEL_ID, system, messages, opts);
  } catch (err) {
    const msg = (err as Error).message || "";
    if (/AccessDenied|ValidationException|ResourceNotFound|not found|don.t have access/i.test(msg)) {
      console.warn(`[ai/bedrock] Primary model ${PRIMARY_MODEL_ID} unavailable, falling back to ${FALLBACK_MODEL_ID}`);
      return await invokeOne(FALLBACK_MODEL_ID, system, messages, opts);
    }
    throw err;
  }
}
