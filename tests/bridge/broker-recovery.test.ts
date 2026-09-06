import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  parsePosixOwnerRecord,
  parseWin32OwnerRecord,
  type BrokerOwnerInfo,
} from "../../src/bridge/broker-heartbeat.js";
import { verifyBrokerSocket } from "../../src/bridge/local-broker.js";
import { isPipeListenerAlive, startLocalIpcServer } from "../../src/bridge/local-ipc.js";

const NOW = 1_700_000_100_000;
const MAX_AGE = 10_000;

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy: () => void };
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

function liveHeartbeat() {
  return {
    version: 1,
    pid: 4242,
    startTimeMs: 1_700_000_000_000,
    checkoutPath: "C:\\repo",
    distCommit: "abc",
    uxpPort: 7777,
    lastTickMs: NOW - 1_000,
  };
}

function staleHeartbeat() {
  return { ...liveHeartbeat(), lastTickMs: NOW - 60_000 };
}

const matchingOwner = async (): Promise<BrokerOwnerInfo | null> => ({
  pid: 4242,
  startTimeMs: 1_700_000_000_000,
  commandLine: "node C:\\repo\\dist\\index.js --broker",
});

describe("verifyBrokerSocket", () => {
  it("returns a healthy verdict for a live heartbeat without side effects", async () => {
    const socket = fakeSocket();
    const kill = vi.fn(async () => {});
    const verdict = await verifyBrokerSocket(socket as never, {
      nowMs: NOW,
      heartbeatMaxAgeMs: MAX_AGE,
      readHeartbeat: () => liveHeartbeat(),
      queryOwner: async () => { throw new Error("must not query"); },
      killProcess: kill,
    });
    expect(verdict).toEqual({ status: "healthy" });
    expect(kill).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("reclaims a zombie broker after a validated owner match", async () => {
    const socket = fakeSocket();
    const kill = vi.fn(async () => {});
    const verdict = await verifyBrokerSocket(socket as never, {
      nowMs: NOW,
      heartbeatMaxAgeMs: MAX_AGE,
      readHeartbeat: () => staleHeartbeat(),
      queryOwner: matchingOwner,
      killProcess: kill,
    });
    expect(verdict).toEqual({ status: "reclaim", pid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242);
    expect(socket.destroyed).toBe(true);
  });

  it("keeps the socket when the stale owner cannot be validated (no regression)", async () => {
    const socket = fakeSocket();
    const kill = vi.fn(async () => {});
    const verdict = await verifyBrokerSocket(socket as never, {
      nowMs: NOW,
      heartbeatMaxAgeMs: MAX_AGE,
      readHeartbeat: () => staleHeartbeat(),
      queryOwner: async () => ({
        pid: 4242,
        startTimeMs: 1_700_000_000_000 + 500_000,
        commandLine: "node C:\\repo\\dist\\index.js --broker",
      }),
      killProcess: kill,
    });
    expect(verdict).toEqual({ status: "healthy" });
    expect(kill).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("tolerates a missing heartbeat file (legacy broker)", async () => {
    const socket = fakeSocket();
    const kill = vi.fn(async () => {});
    const verdict = await verifyBrokerSocket(socket as never, {
      nowMs: NOW,
      heartbeatMaxAgeMs: MAX_AGE,
      readHeartbeat: () => null,
      queryOwner: matchingOwner,
      killProcess: kill,
    });
    expect(verdict).toEqual({ status: "healthy" });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("isPipeListenerAlive", () => {
  it("detects a live listener and a free endpoint", async () => {
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\premiere-probe-${process.pid}-${Date.now()}`
      : `${tmpdir()}/premiere-probe-${process.pid}-${Date.now()}.sock`;
    expect(await isPipeListenerAlive(endpoint)).toBe(false);
    const server = await startLocalIpcServer({
      endpoint,
      onConnection: (socket) => socket.destroy(),
    });
    try {
      expect(await isPipeListenerAlive(endpoint)).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("owner record parsers", () => {
  it("parses a Win32 CIM record into pid, start time, and command line", () => {
    const record = parseWin32OwnerRecord({
      ProcessId: 4242,
      CreationDate: "20260905190737.123456-180",
      CommandLine: "node C:\\repo\\dist\\index.js --broker",
    });
    expect(record?.pid).toBe(4242);
    expect(record?.commandLine).toContain("--broker");
    expect(typeof record?.startTimeMs).toBe("number");
  });

  it("rejects malformed Win32 records", () => {
    expect(parseWin32OwnerRecord({ ProcessId: "x" })).toBeNull();
    expect(parseWin32OwnerRecord(null)).toBeNull();
  });

  it("parses a POSIX ps record", () => {
    const record = parsePosixOwnerRecord("Fri Sep  5 19:07:37 2026 node /repo/dist/index.js --broker");
    expect(record?.commandLine).toContain("--broker");
    expect(typeof record?.startTimeMs).toBe("number");
  });

  it("rejects malformed POSIX records", () => {
    expect(parsePosixOwnerRecord("")).toBeNull();
    expect(parsePosixOwnerRecord("not a date node x")).toBeNull();
  });
});
