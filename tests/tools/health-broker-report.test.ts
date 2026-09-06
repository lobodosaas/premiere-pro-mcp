import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBrokerRuntimeReport,
  writeBrokerHeartbeat,
} from "../../src/bridge/broker-heartbeat.js";
import { getHealthTools } from "../../src/tools/health.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "broker-report-test-"));
  file = join(dir, "heartbeat.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildBrokerRuntimeReport", () => {
  it("reports pid, uptime, heartbeat age, checkout, and endpoint", () => {
    const now = 1_700_000_100_000;
    writeBrokerHeartbeat(file, {
      pid: 4242,
      startTimeMs: 1_700_000_000_000,
      checkoutPath: "C:\\repo",
      distCommit: "abc123",
      uxpPort: 7777,
      lastTickMs: now - 2_000,
    });
    const report = buildBrokerRuntimeReport("pipe-endpoint", file, now);
    expect(report).toMatchObject({
      present: true,
      endpoint: "pipe-endpoint",
      heartbeatAgeMs: 2_000,
      checkoutPath: "C:\\repo",
      distCommit: "abc123",
    });
    expect(typeof report.pid).toBe("number");
    expect(typeof report.uptimeSec).toBe("number");
  });

  it("marks a missing heartbeat instead of throwing", () => {
    const report = buildBrokerRuntimeReport("pipe-endpoint", join(dir, "nope.json"), Date.now());
    expect(report.present).toBe(true);
    expect(report.heartbeatAgeMs).toBeNull();
  });
});

describe("get_capabilities runtime.broker", () => {
  it("exposes the broker report when provided", async () => {
    const tools = getHealthTools({ tempDir: dir }, undefined, undefined, {
      brokerReport: () => ({
        present: true,
        pid: 4242,
        uptimeSec: 60,
        endpoint: "pipe-endpoint",
        heartbeatAgeMs: 1_000,
        checkoutPath: "C:\\repo",
        distCommit: "abc123",
      }),
    });
    const result = await tools.get_capabilities.handler({ tool_names: ["ping"], tool_limit: 1 });
    expect(result.success).toBe(true);
    const runtime = (result.data as { runtime: { broker: { pid: number } } }).runtime;
    expect(runtime.broker.pid).toBe(4242);
  });

  it("reports an absent broker without breaking the response", async () => {
    const tools = getHealthTools({ tempDir: dir });
    const result = await tools.get_capabilities.handler({ tool_names: ["ping"], tool_limit: 1 });
    expect(result.success).toBe(true);
    const runtime = (result.data as { runtime: { broker: { present: boolean } } }).runtime;
    expect(runtime.broker.present).toBe(false);
  });
});
