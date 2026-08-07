/**
 * Escalation: the one path by which a stuck run reaches someone who can unstick
 * it. Tier 1 is the orchestrator session's problem, tier 2 is the human's, and
 * an issue comment is what is left when neither transport is reachable.
 *
 * Two rules shape everything here:
 *
 *  1. An escalation is never silently dropped. Either a transport delivered it,
 *     or `escalate()` throws so the dispatcher learns nobody is reachable. A
 *     swallowed escalation looks exactly like a healthy fleet. Tier 1 is where
 *     that is hardest: the orchestrator *accepts* an injection minutes before
 *     its turn settles, so the dedup marker waits for the settlement and a
 *     late failure falls back to an issue comment for that same escalation.
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
        // Resolves on acceptance, not on an answer, so this does not park the
        // tick behind a model. A rejection means the injection was never taken
        // at all: `undefined` falls through to the human-facing path below
        // rather than losing the escalation — a tier-1 event that reached
        // nobody is indistinguishable from a healthy fleet.
        const receipt = await orchestrator.deliver(e, p.name).catch(() => undefined);
        if (receipt) {
          /**
           * This escalation's own late failure, routed to this escalation's own
           * fallback. The key stays unmarked unless something actually lands:
           * an unmarked key means the next tick re-escalates, which is the
           * whole difference between a late escalation and a lost one. Marking
           * on acceptance is what used to drop it — "notified" written over an
           * event no human ever read, and nothing left to retry it.
           */
          const onTurnFailed = async (cause: unknown): Promise<void> => {
            if (!p.escalation.fallbackToIssueComment) {
              warn(
                `tier 1 escalation on issue #${e.issue} was accepted by the orchestrator but its ` +
                  `turn failed (${errText(cause)}), and no fallback is configured — left unmarked ` +
                  `so the next tick retries`,
              );
              return;
            }
            try {
              await tracker.comment(e.issue, text);
              store.markNotified(key);
            } catch (err) {
              warn(
                `tier 1 escalation on issue #${e.issue} failed after acceptance ` +
                  `(${errText(cause)}) and its issue-comment fallback failed too ` +
                  `(${errText(err)}) — left unmarked so the next tick retries`,
              );
            }
          };

          // Acceptance is not delivery: the orchestrator's turn for *this*
          // injection can still fail minutes from now, so the marker waits for
          // `settled`. Deliberately not awaited — `settled` resolves only when
          // the model has finished answering, which is exactly the wait the
          // dispatcher tick must not take.
          void receipt.settled
            .then(() => {
              store.markNotified(key);
            }, onTurnFailed)
            .catch(() => {
              // `markNotified` is the only thing above that can still throw,
              // and a failing store write must not become an unhandled
              // rejection in a daemon that has nobody left to throw at.
            });
          return;
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
 * The tier-1 settlement tail runs after `escalate()` has already returned, so a
 * failure there has no caller left to throw at. stderr is where it can still be
 * seen: the daemon's log *is* its stderr, so these land in `daemon.log` beside
 * every other conductor line.
 *
 * ponytail: duplicates daemon.ts's one-line format rather than sharing a
 * logger. Upgrade path is a `log.ts` both modules import.
 */
function warn(msg: string): void {
  process.stderr.write(`[conductor ${new Date().toISOString()}] ${msg}\n`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

  // The raw body is what gets parsed; `diagnostic` is only ever for humans.
  // These were one variable once, and the bug that produced was expensive: the
  // 400-char cap meant for a log line was applied first, so `JSON.parse` was
  // handed a truncated object and threw. Telegram echoes the whole message back
  // inside `result.text`, so every page long enough to matter overflowed and was
  // reported as rejected *after being delivered* — with the dedup marker only
  // written on success, that also re-sent the same page every tick. Redaction
  // stays out of the parse for the same reason: it rewrites the very bytes the
  // decision is read from.
  const raw = await res.text().catch(() => "");
  const diagnostic = redact(raw, token).slice(0, 400);
  if (!res.ok) {
    throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${diagnostic}`);
  }

  // Telegram answers 200 with `{"ok":false}` for plenty of real failures
  // (kicked from the chat, bad chat_id), so the status alone proves nothing.
  let ok = false;
  try {
    const parsed: unknown = JSON.parse(raw);
    ok = typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`telegram sendMessage rejected: ${diagnostic}`);
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
