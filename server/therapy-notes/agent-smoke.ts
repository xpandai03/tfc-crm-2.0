/**
 * Read the TherapyNotes agent's last selector smoke for the Submissions health
 * line (shared/tn-agent-smoke.ts says what it is).
 *
 * GET {agent}/api/tn/selector-smoke/last with the same X-API-Key every agent
 * call carries. That route reads the agent's memory and never touches
 * TherapyNotes. 404 (no smoke since the agent's last deploy), a timeout or any
 * error is "no result": the line simply shows nothing extra. Cached for five
 * minutes so a busy Submissions page does not call the agent per view.
 */
import { agentSmokeFromBody, type AgentSmoke } from "@shared/tn-agent-smoke";
import { TN_AGENT_BASE_URL } from "./tn-patients-runner";

const SMOKE_URL = `${TN_AGENT_BASE_URL}/api/tn/selector-smoke/last`;
const TIMEOUT_MS = 3_000;
const CACHE_MS = 5 * 60 * 1000;

let cache: { at: number; value: AgentSmoke | null } | null = null;

export async function fetchAgentSmoke(
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<AgentSmoke | null> {
  const now = opts.now ?? Date.now();
  if (!opts.fetchImpl && cache && now - cache.at < CACHE_MS) return cache.value;
  let value: AgentSmoke | null = null;
  if (process.env.TN_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await (opts.fetchImpl ?? fetch)(SMOKE_URL, {
        method: "GET",
        headers: { "X-API-Key": process.env.TN_API_KEY },
        signal: controller.signal,
      });
      if (res.ok) value = agentSmokeFromBody(await res.json());
    } catch {
      value = null;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!opts.fetchImpl) cache = { at: now, value };
  return value;
}
