import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findHeartbeatOwnerIds } from "../../scripts/stop-mcp-heartbeat.mjs";

let dir;
let file;

const HEARTBEAT = {
  version: 1,
  pid: 4242,
  startTimeMs: 1_700_000_000_000,
  checkoutPath: "C:\\repo",
  distCommit: "abc",
  uxpPort: 7777,
  lastTickMs: 1_700_000_000_000,
};

const matchingOwner = async () => ({
  pid: 4242,
  startTimeMs: 1_700_000_000_000,
  commandLine: "node C:\\repo\\dist\\index.js --broker",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stop-mcp-test-"));
  file = join(dir, "heartbeat.json");
  writeFileSync(file, JSON.stringify(HEARTBEAT), "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findHeartbeatOwnerIds", () => {
  it("returns the heartbeat pid when the owner validates", async () => {
    const result = await findHeartbeatOwnerIds({ heartbeatFile: file, queryOwner: matchingOwner });
    expect(result.ids).toEqual([4242]);
    expect(result.warnings).toEqual([]);
  });

  it("returns empty on PID reuse (start-time mismatch)", async () => {
    const result = await findHeartbeatOwnerIds({
      heartbeatFile: file,
      queryOwner: async () => ({
        pid: 4242,
        startTimeMs: 1_700_000_000_000 + 600_000,
        commandLine: "node C:\\repo\\dist\\index.js --broker",
      }),
    });
    expect(result.ids).toEqual([]);
  });

  it("returns empty when the command line lacks the broker marker", async () => {
    const result = await findHeartbeatOwnerIds({
      heartbeatFile: file,
      queryOwner: async () => ({
        pid: 4242,
        startTimeMs: 1_700_000_000_000,
        commandLine: "node C:\\other\\app.js",
      }),
    });
    expect(result.ids).toEqual([]);
  });

  it("returns empty when the process is gone", async () => {
    const result = await findHeartbeatOwnerIds({
      heartbeatFile: file,
      queryOwner: async () => null,
    });
    expect(result.ids).toEqual([]);
  });

  it("warns instead of killing when the owner query fails", async () => {
    const result = await findHeartbeatOwnerIds({
      heartbeatFile: file,
      queryOwner: async () => { throw new Error("denied"); },
    });
    expect(result.ids).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns about elevation when the command line is unreadable", async () => {
    const result = await findHeartbeatOwnerIds({
      heartbeatFile: file,
      queryOwner: async () => ({ pid: 4242, startTimeMs: 1_700_000_000_000, commandLine: "" }),
    });
    expect(result.ids).toEqual([]);
    expect(result.warnings.join(" ").toLowerCase()).toContain("elevat");
  });

  it("returns empty when the heartbeat file is missing or corrupt", async () => {
    const missing = await findHeartbeatOwnerIds({
      heartbeatFile: join(dir, "nope.json"),
      queryOwner: matchingOwner,
    });
    expect(missing.ids).toEqual([]);
    writeFileSync(file, "{broken", "utf8");
    const corrupt = await findHeartbeatOwnerIds({ heartbeatFile: file, queryOwner: matchingOwner });
    expect(corrupt.ids).toEqual([]);
  });
});
