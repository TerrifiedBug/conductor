import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "./store.ts";

test("--version, -V and version print the installed package version", async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  };
  for (const arg of ["--version", "-V", "version"]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), arg], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe(pkg.version);
    expect((await new Response(child.stderr).text()).trim()).toBe("");
  }
});

test("extend rejects partial or missing turn counts before touching daemon state", async () => {
  for (const args of [
    ["extend", "84", "--turns", "180x"],
    ["extend", "84"],
  ]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect((await new Response(child.stdout).text()).trim()).toBe("");
    expect(await new Response(child.stderr).text()).toContain(
      "extend needs --turns with a positive integer",
    );
  }
});

test("friction rejects unknown categories and unbounded details before loading config", async () => {
  for (const args of [
    ["friction", "made-up", "--detail", "x"],
    ["friction", "toString", "--detail", "x"],
    ["friction", "report-noise"],
    ["friction", "report-noise", "--detail", "--issue", "12"],
    ["friction", "report-surprise", "--detail", "x".repeat(161)],
  ]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect((await new Response(child.stdout).text()).trim()).toBe("");
    expect(await new Response(child.stderr).text()).toContain("friction needs");
  }
});

test("friction records a bounded feedback observation for the selected project", async () => {
  const home = mkdtempSync(join(tmpdir(), "conductor-friction-cli-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          name: "demo",
          tracker: { kind: "github", repo: "acme/demo" },
          queueLabel: "ready-for-agent",
          routing: { repos: { api: { cloneUrl: "git@github.com:acme/api.git" } } },
          escalation: { fallbackToIssueComment: true, orchestrator: "external" },
        },
      ],
    }),
  );

  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli.ts"),
        "friction",
        "report-surprise",
        "--detail",
        "material failure was absent",
        "--issue",
        "12",
        "--project",
        "demo",
      ],
      {
        env: { ...process.env, OMP_CONDUCTOR_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      "friction recorded for demo: report-surprise",
    );
    expect((await new Response(child.stderr).text()).trim()).toBe("");

    const store = openStore(join(home, "conductor.db"));
    expect(store.pendingFriction("demo", 0, 1, Date.now())).toMatchObject([
      {
        kind: "feedback:report-surprise",
        observations: 1,
        occurrences: 1,
        issues: [12],
        samples: ["material failure was absent"],
      },
    ]);
    store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
