import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getBrokerHeartbeatPath,
  isHeartbeatLive,
  readBrokerHeartbeat,
  resolveStaleBroker,
  writeBrokerHeartbeat,
  type BrokerHeartbeat,
  type BrokerOwnerInfo,
} from "../../src/bridge/broker-heartbeat.js";

let dir: string;
let file: string;

const BASE = {
  pid: 1234,
  startTimeMs: 1_700_000_000_000,
  checkoutPath: "C:\\repo\\mcp adobe premiere",
  distCommit: "abc123",
  uxpPort: 7777,
} as const;

function heartbeatAt(lastTickMs: number): BrokerHeartbeat {
  return { version: 1, ...BASE, lastTickMs };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "premiere-heartbeat-test-"));
  file = join(dir, "heartbeat.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("broker heartbeat file", () => {
  it("round-trips a heartbeat through write and read", () => {
    const written = writeBrokerHeartbeat(file, { ...BASE, lastTickMs: 1_700_000_100_000 });
    expect(written.version).toBe(1);
    expect(readBrokerHeartbeat(file)).toEqual(written);
  });

  it("returns null for a missing file", () => {
    expect(readBrokerHeartbeat(join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt or wrong-shaped content", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{not json", "utf8");
    expect(readBrokerHeartbeat(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, pid: "x" }), "utf8");
    expect(readBrokerHeartbeat(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 999, ...BASE, lastTickMs: 1 }), "utf8");
    expect(readBrokerHeartbeat(file)).toBeNull();
  });

  it("derives a per-user temp path by default", () => {
    const resolved = getBrokerHeartbeatPath();
    expect(resolved.startsWith(tmpdir())).toBe(true);
    expect(resolved.endsWith(".json")).toBe(true);
  });
});

describe("isHeartbeatLive", () => {
  it("treats a fresh tick as live and an old tick as stale", () => {
    const now = 1_700_000_100_000;
    expect(isHeartbeatLive(heartbeatAt(now - 1_000), now, 10_000)).toBe(true);
    expect(isHeartbeatLive(heartbeatAt(now - 30_000), now, 10_000)).toBe(false);
  });

  it("rejects future ticks beyond clock-skew tolerance", () => {
    const now = 1_700_000_100_000;
    expect(isHeartbeatLive(heartbeatAt(now + 60_000), now, 10_000)).toBe(false);
    expect(isHeartbeatLive(heartbeatAt(now + 1_000), now, 10_000)).toBe(true);
  });
});

describe("resolveStaleBroker", () => {
  const NOW = 1_700_000_100_000;
  const MAX_AGE = 10_000;
  const stale = () => heartbeatAt(NOW - 60_000);

  it("keeps a live broker untouched", async () => {
    const query = async (): Promise<BrokerOwnerInfo | null> => {
      throw new Error("must not query a live broker");
    };
    await expect(resolveStaleBroker(heartbeatAt(NOW - 1_000), NOW, {
      maxAgeMs: MAX_AGE,
      queryOwner: query,
    })).resolves.toEqual({ action: "keep", pid: BASE.pid });
  });

  it("authorizes kill when the stale owner matches pid, start time, and broker marker", async () => {
    const query = async (): Promise<BrokerOwnerInfo | null> => ({
      pid: BASE.pid,
      startTimeMs: BASE.startTimeMs,
      commandLine: "node C:\\repo\\dist\\index.js --broker",
    });
    await expect(resolveStaleBroker(stale(), NOW, {
      maxAgeMs: MAX_AGE,
      queryOwner: query,
    })).resolves.toEqual({ action: "kill", pid: BASE.pid });
  });

  it("never kills on PID reuse (start-time mismatch)", async () => {
    const query = async (): Promise<BrokerOwnerInfo | null> => ({
      pid: BASE.pid,
      startTimeMs: BASE.startTimeMs + 999_000,
      commandLine: "node C:\\repo\\dist\\index.js --broker",
    });
    await expect(resolveStaleBroker(stale(), NOW, {
      maxAgeMs: MAX_AGE,
      queryOwner: query,
    })).resolves.toEqual({ action: "keep", pid: BASE.pid });
  });

  it("never kills when the command line lacks the broker marker", async () => {
    const query = async (): Promise<BrokerOwnerInfo | null> => ({
      pid: BASE.pid,
      startTimeMs: BASE.startTimeMs,
      commandLine: "node C:\\other\\app.js",
    });
    await expect(resolveStaleBroker(stale(), NOW, {
      maxAgeMs: MAX_AGE,
      queryOwner: query,
    })).resolves.toEqual({ action: "keep", pid: BASE.pid });
  });

  it("reports stale-no-owner when the process is gone", async () => {
    const query = async (): Promise<BrokerOwnerInfo | null> => null;
    await expect(resolveStaleBroker(stale(), NOW, {
      maxAgeMs: MAX_AGE,
      queryOwner: query,
    })).resolves.toEqual({ action: "stale-no-owner", pid: BASE.pid });
  });

  it("reports unknown when the owner query fails", async () => {
    const query = async (): Promise<BrokerOwnerInfo | null> => {
      throw new Error("WMI denied");
    };
    await expect(resolveStaleBroker(stale(), NOW, {
      maxAgeMs: MAX_AGE,
      queryOwner: query,
    })).resolves.toEqual({ action: "unknown", pid: BASE.pid });
  });
});
