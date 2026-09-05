import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServerBuildInfo } from "../src/build-info.js";
import { getHealthTools } from "../src/tools/health.js";
import { resolveToolPacks } from "../src/workflows/tool-packs.js";
import {
  startLocalBroker,
  type LocalBroker,
} from "../src/bridge/local-broker.js";
import { getLocalBrokerEndpoint } from "../src/bridge/local-ipc.js";
import { randomUUID } from "node:crypto";

const TOKEN = "test-token-at-least-16-characters";
const brokers: LocalBroker[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "premiere-mcp-buildinfo-"));
  tempDirs.push(directory);
  return directory;
}

describe("readServerBuildInfo", () => {
  it("never throws and reports found:false when the file is missing", async () => {
    const directory = await tempDir();
    const info = readServerBuildInfo(path.join(directory, "no-such-dir"));
    expect(info.found).toBe(false);
  });

  it("reports found:false for malformed or wrong-shaped files", async () => {
    const directory = await tempDir();
    await writeFile(path.join(directory, "build-info.json"), "{not json");
    expect(readServerBuildInfo(directory).found).toBe(false);
    await writeFile(path.join(directory, "build-info.json"), JSON.stringify({ commit: 42 }));
    expect(readServerBuildInfo(directory).found).toBe(false);
  });

  it("parses a valid build-info.json", async () => {
    const directory = await tempDir();
    await writeFile(path.join(directory, "build-info.json"), JSON.stringify({
      schemaVersion: 1,
      commit: "abc123",
      packageVersion: "1.14.4",
      builtAt: "2026-01-01T00:00:00.000Z",
    }));
    const info = readServerBuildInfo(directory);
    expect(info).toMatchObject({ found: true, commit: "abc123", packageVersion: "1.14.4" });
  });
});

describe("write-build-info script", () => {
  it("writes a valid build-info.json to --out without touching the repo", async () => {
    const directory = await tempDir();
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../scripts/write-build-info.mjs", import.meta.url)),
      "--out",
      directory,
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
    const info = readServerBuildInfo(directory);
    expect(info.found).toBe(true);
    expect(typeof info.commit).toBe("string");
    expect(typeof info.builtAt).toBe("string");
    expect(typeof info.packageVersion).toBe("string");
  });
});

describe("get_capabilities runtime identity", () => {
  it("reports the captured server build, active packs, per-tool registration, and UXP panel state", async () => {
    const tools = getHealthTools(
      { tempDir: await tempDir() },
      { capabilities: new Set(["inspect"]), source: "explicit" },
      () => ({
        ping: { description: "Ping." },
        add_keyframe: { description: "Add a keyframe." },
      }),
      {
        toolPacks: resolveToolPacks("inspection"),
        buildInfo: {
          found: true,
          commit: "abc123",
          packageVersion: "1.14.4",
          builtAt: "2026-01-01T00:00:00.000Z",
          source: "test",
          capturedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    );
    const result = await tools.get_capabilities.handler({});
    expect(result.success).toBe(true);
    expect(result.data.runtime.build).toMatchObject({ found: true, commit: "abc123" });
    expect(result.data.runtime.toolPacks.selected).toEqual(["inspection"]);
    const entries = new Map(result.data.tools.tools.map((tool: { name: string }) => [tool.name, tool]));
    expect(entries.get("ping")).toMatchObject({ registered: true });
    expect(entries.get("add_keyframe")).toMatchObject({ registered: false });
    expect(result.data.runtime.uxp).toMatchObject({ connected: false });
  });
});

describe("broker build capture", () => {
  it("captures the injected build info at startup and exposes it in state()", async () => {
    const broker = await startLocalBroker({
      bridgeOptions: { tempDir: await tempDir() },
      uxpToken: TOKEN,
      uxpPort: 0,
      ipcEndpoint: getLocalBrokerEndpoint({ username: `build-${randomUUID()}` }),
      toolPacks: "inspection",
      buildInfo: {
        found: true,
        commit: "deadbee",
        packageVersion: "9.9.9",
        builtAt: "2026-01-01T00:00:00.000Z",
        source: "test",
      },
    });
    brokers.push(broker);
    expect(broker.buildInfo).toMatchObject({ found: true, commit: "deadbee" });
    expect(typeof broker.buildInfo.capturedAt).toBe("string");
    expect(broker.state().build).toMatchObject({ commit: "deadbee" });
  });
});
