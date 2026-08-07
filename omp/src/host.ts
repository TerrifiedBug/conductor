/**
 * Host facts the wizard and status surfaces need without dragging in systemd
 * or the tracker. Pure so tests pin the thresholds without a real machine.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DEFAULT_CAPS } from "./types.ts";

/** 16 GiB — below this, two in-process omp sessions plus the orchestrator are
 *  a measured swap risk on a shared VPS (issue #51: 3–4GB peaks on 7.6GB). */
export const SMALL_HOST_RAM_BYTES = 16 * 1024 ** 3;

/**
 * MemTotal from a `/proc/meminfo` body, in bytes. kB × 1024, matching what
 * Linux reports; undefined when the line is missing or unparsable.
 */
export function ramBytesFromMeminfo(text: string): number | undefined {
  const m = /^MemTotal:\s+(\d+)\s+kB\s*$/m.exec(text);
  if (m === null) return undefined;
  const kib = Number(m[1]);
  if (!Number.isFinite(kib) || kib <= 0) return undefined;
  return kib * 1024;
}

/** Darwin `sysctl -n hw.memsize` stdout → bytes. */
export function ramBytesFromSysctl(raw: string): number | undefined {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Total installed RAM when the host will say, otherwise undefined. Never
 * throws: a container without /proc or a locked-down sysctl is "unknown", and
 * callers fall back to the shipped worker default.
 */
export function hostRamBytes(): number | undefined {
  if (process.platform === "linux") {
    try {
      return ramBytesFromMeminfo(readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const ran = spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" });
    if (ran.status !== 0 || ran.stdout === null) return undefined;
    return ramBytesFromSysctl(ran.stdout);
  }
  return undefined;
}

/**
 * Setup default for `maxConcurrentWorkers`. Small hosts get 1; everyone else
 * keeps {@link DEFAULT_CAPS.maxConcurrentWorkers}. Unknown RAM keeps the
 * shipped default — guessing low would silently halve throughput on a beefy
 * box whose /proc we cannot read.
 */
export function recommendedMaxWorkers(ramBytes: number | undefined): number {
  if (ramBytes === undefined) return DEFAULT_CAPS.maxConcurrentWorkers;
  return ramBytes < SMALL_HOST_RAM_BYTES ? 1 : DEFAULT_CAPS.maxConcurrentWorkers;
}

/** Compact binary units for status lines (`3.2 GB`, `430 MB`). */
export function formatRss(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * `rssBytes` from a `/healthz` JSON body. Old daemons omit the field; garbage
 * answers undefined rather than NaN so status can hide the line.
 */
export function rssBytesFromHealthz(body: string | undefined): number | undefined {
  if (body === undefined || body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const n = (parsed as { rssBytes?: unknown }).rssBytes;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
    return n;
  } catch {
    return undefined;
  }
}
