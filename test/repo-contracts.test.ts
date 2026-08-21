import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("repo entry points", () => {
  it("is frontend and protocol only after backend consolidation", async () => {
    const root = new URL("../", import.meta.url);

    await expect(access(new URL("apps/web/package.json", root))).resolves.toBeUndefined();
    await expect(access(new URL("packages/protocol/package.json", root))).resolves.toBeUndefined();
    await expect(access(new URL("apps/server/package.json", root))).rejects.toThrow();

    const packageJson = JSON.parse(
      await readFile(new URL("package.json", root), "utf8"),
    ) as { scripts: Record<string, string> };
    const serializedScripts = JSON.stringify(packageJson.scripts);

    expect(serializedScripts).not.toContain("@scrum-poker/server");
    expect(serializedScripts).not.toContain("apps/server");
    expect(serializedScripts).not.toContain("scrum-poker-backend");
  });

  it("keeps E2E and load clients pointed at an explicit external API", async () => {
    const packageJson = await readJson("package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const e2eSources = await Promise.all([
      readFile("e2e/accessibility.spec.ts", "utf8"),
      readFile("e2e/reconnect.spec.ts", "utf8"),
      readFile("e2e/room-flow.spec.ts", "utf8"),
    ]);
    const loadClient = await readFile("load/sse-load.ts", "utf8");
    const loadTests = await readFile("load/sse-load.test.ts", "utf8");

    expect(scripts["test:e2e"]).not.toMatch(/@scrum-poker\/server|apps\/server/);
    expect(e2eSources.every((source) => source.includes("VITE_API_BASE_URL"))).toBe(true);
    expect(e2eSources.join("\n")).not.toMatch(/@scrum-poker\/server|apps\/server/);
    expect(scripts["test:load"]).not.toMatch(/@scrum-poker\/server|apps\/server/);
    expect(loadTests).not.toMatch(/@scrum-poker\/server|apps\/server/);
    expect(loadClient).toContain("An explicit --base-url is required.");
  });

  it("wires lint:no-sockets to a real guard", async () => {
    const pkg = await readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;

    expect(scripts["lint:no-sockets"]).not.toBe('node -e "process.exit(0)"');
    expect(scripts["lint:no-sockets"]).toContain("scripts/no-sockets.mjs");
  });

  it("does not leave test:e2e as a false-green placeholder", async () => {
    const pkg = await readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;

    expect(scripts["test:e2e"]).not.toBe('node -e "process.exit(0)"');
    expect(scripts["test:e2e"]).toMatch(/not-implemented|playwright|vitest|start-server-and-test/i);
  });

  it("does not leave test:load as a false-green placeholder", async () => {
    const pkg = await readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;

    expect(scripts["test:load"]).not.toBe('node -e "process.exit(0)"');
    expect(scripts["test:load"]).toMatch(/not-implemented|load/i);
  });

  it("exposes a usable workspace configuration for protocol", async () => {
    const workspace = await readFile("vitest.workspace.ts", "utf8");

    expect(workspace).toContain("defineWorkspace");
    expect(workspace).toContain("packages/protocol");
    expect(workspace).not.toContain("export default []");
  });
});
