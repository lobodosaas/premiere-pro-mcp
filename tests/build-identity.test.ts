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
    await writeFile(path.join(directory, "build-info.json"), JSON.stringify([1, 2]));
    expect(readServerBuildInfo(directory).found).toBe(false);
    await writeFile(path.join(directory, "build-info.json"), JSON.stringify({ commit: "a", packageVersion: "b" }));
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

  it("records sha256 hashes of the shipped server and panel artifacts", async () => {
    const directory = await tempDir();
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../scripts/write-build-info.mjs", import.meta.url)),
      "--out",
      directory,
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
    const info = readServerBuildInfo(directory);
    expect(info.found).toBe(true);
    expect(info.files?.["dist/index.js"]).toMatch(/^[0-9a-f]{64}$/);
    expect(info.files?.["uxp-plugin/advanced-workflows.cjs"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects build records with malformed artifact hashes", async () => {
    const directory = await tempDir();
    await writeFile(path.join(directory, "build-info.json"), JSON.stringify({
      schemaVersion: 1,
      commit: "abc123",
      packageVersion: "1.14.4",
      builtAt: "2026-01-01T00:00:00.000Z",
      files: { "dist/index.js": "not-a-hash" },
    }));
    expect(readServerBuildInfo(directory).found).toBe(false);
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
    expect(result.data.runtime.uxp).toMatchObject({ connected: false, status: "no_bridge" });
  });

  it("summarizes a connected UXP panel without leaking tokens or command payloads", async () => {
    const fakeBridge = {
      getState: () => ({
        status: "connected",
        connected: true,
        protocolVersion: 2,
        connectedAt: "2026-01-01T00:00:00.000Z",
        capabilities: {
          hostVersion: "26.3.2",
          commands: {
            "parameters.set": { supported: true },
            "captions.create": { supported: false },
          },
        },
      }),
    };
    const tools = getHealthTools(
      { tempDir: await tempDir() },
      { capabilities: new Set(["inspect"]), source: "explicit" },
      () => ({}),
      { uxpBridge: fakeBridge as never },
    );
    const result = await tools.get_capabilities.handler({});
    expect(result.data.runtime.uxp).toMatchObject({
      connected: true,
      protocolVersion: 2,
      hostVersion: "26.3.2",
      supportedCommandCount: 1,
      connectedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("degrades UXP panel diagnostics when state reading fails", async () => {
    const throwing = { getState: () => { throw new Error("boom"); } };
    const tools = getHealthTools(
      { tempDir: await tempDir() },
      undefined,
      () => ({}),
      { uxpBridge: throwing as never },
    );
    const result = await tools.get_capabilities.handler({});
    expect(result.data.runtime.uxp).toMatchObject({ connected: false, status: "unknown" });
  });

  it("treats a listening-only bridge as disconnected", async () => {
    const listening = { getState: () => ({ status: "listening", connected: false }) };
    const tools = getHealthTools(
      { tempDir: await tempDir() },
      undefined,
      () => ({}),
      { uxpBridge: listening as never },
    );
    const result = await tools.get_capabilities.handler({});
    expect(result.data.runtime.uxp).toMatchObject({ connected: false, status: "listening" });
  });

  it("echoes the connected panel version separately from the server build", async () => {
    const fakeBridge = {
      getState: () => ({
        status: "connected",
        connected: true,
        protocolVersion: 2,
        connectedAt: "2026-01-01T00:00:00.000Z",
        capabilities: { panelVersion: "9.9.9", commands: {} },
      }),
    };
    const tools = getHealthTools(
      { tempDir: await tempDir() },
      undefined,
      () => ({}),
      {
        uxpBridge: fakeBridge as never,
        buildInfo: { found: true, commit: "srv", packageVersion: "1.0.0", builtAt: "2026-01-01T00:00:00.000Z", source: "test" },
      },
    );
    const result = await tools.get_capabilities.handler({});
    expect(result.data.runtime.uxp).toMatchObject({ connected: true, panelVersion: "9.9.9" });
    expect(result.data.runtime.build).toMatchObject({ commit: "srv" });
  });

  it("registers animation tools only under the animation pack", async () => {
    const catalog = () => ({
      ping: { description: "Ping." },
      add_keyframe: { description: "Add a keyframe." },
      animate_caption_clip_uxp: { description: "Caption entrance." },
    });
    const capabilities = { capabilities: new Set(["inspect", "edit"]), source: "explicit" } as const;

    const withAnimation = getHealthTools({ tempDir: await tempDir() }, capabilities, catalog, {
      toolPacks: resolveToolPacks("essential,animation"),
    });
    const animated = new Map(
      (await withAnimation.get_capabilities.handler({})).data.tools.tools.map((tool: { name: string }) => [tool.name, tool]),
    );
    expect(animated.get("add_keyframe")).toMatchObject({ registered: true });
    expect(animated.get("animate_caption_clip_uxp")).toMatchObject({ registered: true });

    const essentialOnly = getHealthTools({ tempDir: await tempDir() }, capabilities, catalog, {
      toolPacks: resolveToolPacks("essential"),
    });
    const narrowed = new Map(
      (await essentialOnly.get_capabilities.handler({})).data.tools.tools.map((tool: { name: string }) => [tool.name, tool]),
    );
    expect(narrowed.get("add_keyframe")).toMatchObject({ registered: false });
    expect(narrowed.get("animate_caption_clip_uxp")).toMatchObject({ registered: false });
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

  it("freezes the captured build snapshot against later mutation", async () => {
    const broker = await startLocalBroker({
      bridgeOptions: { tempDir: await tempDir() },
      uxpToken: TOKEN,
      uxpPort: 0,
      ipcEndpoint: getLocalBrokerEndpoint({ username: `build-frozen-${randomUUID()}` }),
      buildInfo: {
        found: true,
        commit: "deadbee",
        packageVersion: "9.9.9",
        builtAt: "2026-01-01T00:00:00.000Z",
        source: "test",
      },
    });
    brokers.push(broker);
    expect(Object.isFrozen(broker.buildInfo)).toBe(true);
  });

  it("falls back to reading build info from the running module directory when nothing is injected", async () => {
    const broker = await startLocalBroker({
      bridgeOptions: { tempDir: await tempDir() },
      uxpToken: TOKEN,
      uxpPort: 0,
      ipcEndpoint: getLocalBrokerEndpoint({ username: `build-fallback-${randomUUID()}` }),
    });
    brokers.push(broker);
    // Under vitest the module runs from src/ (no build-info.json sibling), so
    // the graceful-missing path is exercised; a broker launched from dist/
    // reports found:true with the build commit instead.
    expect(broker.buildInfo.found).toBe(false);
    expect(typeof broker.buildInfo.capturedAt).toBe("string");
    expect(broker.state().build).toMatchObject({ found: false });
  });
});
