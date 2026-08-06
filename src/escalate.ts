/**
 * Escalation: the one path by which a stuck run reaches someone who can unstick
 * it. Tier 1 is the orchestrator session's problem, tier 2 is the human's, and
 * an issue comment is what is left when neither transport is reachable.
 *
 * Two rules shape everything here:
 *
 *  1. An escalation is never silently dropped. Either a transport accepted it,
 *     or `escalate()` throws so the dispatcher learns nobody is reachable. A
 *     swallowed escalation looks exactly like a healthy fleet.
 *  2. An escalation is never repeated. The dispatcher re-notices the same
 *     unroutable issue on every poll, so the store's notification ledger — not
 *     the loop — is what stops a human being paged every five minutes.
 *
 * The bot token is read at send time and never travels further than the request
 * URL: it is redacted out of every error string this module can produce, since
 * those strings end up in daemon logs and, on the fallback path, in a public
 * issue comment.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OrchestratorHandle } from "./orchestrator.ts";
import type { Escalation, ProjectConfig, Store, Tracker } from "./types.ts";

/** Telegram rejects `sendMessage` over 4096 chars; leave room for the marker. */
const TELEGRAM_TEXT_LIMIT = 4000;

export interface Escalator {
  escalate(e: Escalation): Promise<void>;
}

/**
 * The human-facing text, shared by both transports so a Telegram ping and its
 * issue-comment fallback are the same message — a human comparing the two
 * should never have to wonder whether they describe the same event.
 *
 * Deliberately plain: Telegram is called without `parse_mode`, because an issue
 * title containing `_` or `*` would otherwise make Telegram reject the whole
 * send, turning a cosmetic problem into a lost escalation. Plain text is also
 * valid Markdown, so the same string renders fine as an issue comment.
 */
export function formatEscalation(e: Escalation, project: string): string {
  const lines = [
    `omp-conductor · tier ${e.tier} escalation`,
    `project: ${project}`,
    `issue: #${e.issue}`,
    `summary: ${e.summary}`,
  ];
  if (e.detail) lines.push(`detail: ${e.detail}`);
  if (e.runId) lines.push(`run: ${e.runId}`);
  return lines.join("\n");
}

/**
 * `orchestrator` is the tier-1 transport when one is running: a tier-1
 * escalation is the orchestrator's problem, not the human's, and an injected
 * prompt is the only form of it that can actually change anything. It stays
 * optional so a daemon whose orchestrator failed to start — and the unit suite —
 * still escalate, just to an issue comment.
 */
export function createEscalator(
  p: ProjectConfig,
  tracker: Tracker,
  store: Store,
  orchestrator?: OrchestratorHandle,
): Escalator {
  return {
    async escalate(e: Escalation): Promise<void> {
      // Stable across daemon restarts: same project, issue, tier and summary is
      // the same event, however many times the loop rediscovers it.
      const key = `${p.name}:${e.issue}:${e.tier}:${e.summary}`;
      if (store.wasNotified(key)) return;

      const text = formatEscalation(e, p.name);
      const chatId = p.escalation.telegramChatId;

      if (e.tier === 1 && orchestrator) {
        try {
          // Resolves on acceptance, not on an answer, so this does not park the
          // tick behind a model. Acceptance *is* the escalation: the run is
          // parked and safe, and the orchestrator now owns deciding what
          // happens to it.
          await orchestrator.deliver(e, p.name);
          store.markNotified(key);
          return;
        } catch {
          // The re-briefing channel is down. Fall through to the human-facing
          // path below rather than lose the escalation — a tier-1 event that
          // reached nobody is indistinguishable from a healthy fleet, and the
          // marker deliberately stays unwritten until something accepts it.
        }
      }

      if (e.tier === 2 && chatId) {
        const token = readTelegramToken();
        if (token) {
          // A send failure throws: `markNotified` stays uncalled so the next
          // poll retries instead of writing the event off as delivered.
          // ponytail: no retry/backoff in here — the dispatcher tick is the
          // retry. Upgrade path is a durable outbox table in the store.
          await sendTelegram(token, chatId, text);
          store.markNotified(key);
          return;
        }
      }

      // Tier 1 lands here with no orchestrator, or with one that would not take
      // the injection; tier 2 lands here when omp-telegram is not installed or
      // the project never configured a chat id.
      if (!p.escalation.fallbackToIssueComment) {
        throw new Error(
          `no escalation transport configured for project "${p.name}": tier ${e.tier} ` +
            `escalation on issue #${e.issue} (${e.summary}) could not be delivered — ` +
            `set escalation.telegramChatId or escalation.fallbackToIssueComment`,
        );
      }
      await tracker.comment(e.issue, text);
      store.markNotified(key);
    },
  };
}

/**
 * omp-telegram owns `<state dir>/.env`; conductor only borrows the token, so a
 * user already running that bot gets tier-2 pings with no extra configuration.
 * Absence is not an error — it just means tier 2 degrades to the fallback.
 */
function readTelegramToken(): string | undefined {
  const override = process.env.OMP_TELEGRAM_STATE_DIR?.trim();
  const dir = override ? override : join(homedir(), ".omp", "agent", "telegram");
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return undefined;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    // ponytail: hard truncation rather than splitting across messages — the
    // tail of a stack trace is rarely the interesting part. Upgrade path is to
    // attach the overflow as a file via sendDocument.
    text:
      text.length > TELEGRAM_TEXT_LIMIT ? `${text.slice(0, TELEGRAM_TEXT_LIMIT)}\n[truncated]` : text,
    disable_web_page_preview: true,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (cause) {
    // The URL embeds the token, and runtimes love to quote the failing URL back
    // at you — redact before this string reaches a log or an issue comment.
    const nested = cause instanceof Error && cause.cause instanceof Error ? `: ${cause.cause.message}` : "";
    const reason = cause instanceof Error ? `${cause.message}${nested}` : String(cause);
    throw new Error(`telegram sendMessage failed: ${redact(reason, token)}`);
  }

  const payload = redact(await res.text().catch(() => ""), token).slice(0, 400);
  if (!res.ok) {
    throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${payload}`);
  }

  // Telegram answers 200 with `{"ok":false}` for plenty of real failures
  // (kicked from the chat, bad chat_id), so the status alone proves nothing.
  let ok = false;
  try {
    const parsed: unknown = JSON.parse(payload);
    ok = typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`telegram sendMessage rejected: ${payload}`);
  }
}

/**
 * Strips the bot token — and its secret half, which some proxies log on its
 * own — out of any string that is about to be thrown, logged or commented.
 */
function redact(text: string, token: string): string {
  let out = token ? text.split(token).join("<redacted>") : text;
  const colon = token.indexOf(":");
  const secret = colon >= 0 ? token.slice(colon + 1) : "";
  if (secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out;
}
