import { describe, expect, test } from "bun:test";
import {
  formatRss,
  ramBytesFromMeminfo,
  ramBytesFromSysctl,
  recommendedMaxWorkers,
  rssBytesFromHealthz,
  SMALL_HOST_RAM_BYTES,
} from "./host.ts";
import { DEFAULT_CAPS } from "./types.ts";

test("MemTotal kB becomes bytes", () => {
  expect(ramBytesFromMeminfo("MemTotal:       8000000 kB\n")).toBe(8000000 * 1024);
});

test("a missing MemTotal is unknown, not zero", () => {
  expect(ramBytesFromMeminfo("MemFree: 1 kB\n")).toBeUndefined();
});

test("sysctl hw.memsize is bytes already", () => {
  expect(ramBytesFromSysctl("17179869184\n")).toBe(16 * 1024 ** 3);
});

test("hosts under 16 GiB default to one worker; 16 GiB and up keep the shipped default", () => {
  expect(recommendedMaxWorkers(SMALL_HOST_RAM_BYTES - 1)).toBe(1);
  expect(recommendedMaxWorkers(SMALL_HOST_RAM_BYTES)).toBe(DEFAULT_CAPS.maxConcurrentWorkers);
  expect(recommendedMaxWorkers(undefined)).toBe(DEFAULT_CAPS.maxConcurrentWorkers);
});

test("healthz rssBytes is read; absent or garbage is hidden", () => {
  expect(rssBytesFromHealthz('{"ok":true,"rssBytes":3221225472}')).toBe(3221225472);
  expect(rssBytesFromHealthz('{"ok":true}')).toBeUndefined();
  expect(rssBytesFromHealthz("not-json")).toBeUndefined();
});

test("formatRss picks GB then MB", () => {
  expect(formatRss(3.2 * 1024 ** 3)).toBe("3.2 GB");
  expect(formatRss(430 * 1024 ** 2)).toBe("430 MB");
});
