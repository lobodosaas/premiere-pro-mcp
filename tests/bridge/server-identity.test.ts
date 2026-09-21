import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_SERVER_IDENTITY_FILE,
  writeServerIdentity,
} from "../../src/bridge/file-bridge.js";

describe("bridge server identity", () => {
  it("publishes the running server version next to the bridge protocol files", () => {
    const directory = mkdtempSync(join(tmpdir(), "premiere-mcp-identity-"));
    try {
      writeServerIdentity(directory, {
        found: true,
        commit: "abc1234",
        packageVersion: "9.9.9",
        builtAt: null,
      });

      const record = JSON.parse(readFileSync(join(directory, BRIDGE_SERVER_IDENTITY_FILE), "utf-8"));
      expect(record).toMatchObject({ schemaVersion: 1, version: "9.9.9", commit: "abc1234" });
      expect(typeof record.pid).toBe("number");
      expect(typeof record.updatedAt).toBe("string");
      expect(readdirSync(directory).some((name) => name.endsWith(".staged"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never fails a bridge command when the identity file cannot be written", () => {
    const missing = join(tmpdir(), `premiere-mcp-missing-${Date.now()}`);
    expect(() => writeServerIdentity(missing)).not.toThrow();
    expect(() => {
      mkdirSync(join(missing, "nested"), { recursive: true });
    }).not.toThrow();
  });
});
