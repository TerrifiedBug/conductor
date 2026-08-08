import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
