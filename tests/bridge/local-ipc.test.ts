import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import {
  connectLocalIpc,
  getLocalBrokerEndpoint,
  getLocalBrokerLockEndpoint,
  startLocalIpcServer,
  type LocalIpcServer,
} from "../../src/bridge/local-ipc.js";

const servers: LocalIpcServer[] = [];
const sockets: NodeJS.WritableStream[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function uniqueEndpoint(): string {
  return getLocalBrokerEndpoint({
    username: `test-${randomUUID()}`,
    tempDir: os.tmpdir(),
  });
}

describe("local broker IPC", () => {
  it("derives one stable per-user endpoint without using the UXP port", () => {
    const first = getLocalBrokerEndpoint({
      platform: "win32",
      username: "gusta",
      tempDir: "C:\\temp\\premiere-mcp",
    });
    const second = getLocalBrokerEndpoint({
      platform: "win32",
      username: "gusta",
      tempDir: "C:\\temp\\premiere-mcp",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^\\\\\.\\pipe\\premiere-pro-mcp-/);
    expect(first).not.toContain("7777");
  });

  it("derives a separate stable owner endpoint", () => {
    const publicEndpoint = getLocalBrokerEndpoint({
      platform: "win32",
      username: "gusta",
    });
    const lockEndpoint = getLocalBrokerLockEndpoint(publicEndpoint, "win32");

    expect(lockEndpoint).not.toBe(publicEndpoint);
    expect(lockEndpoint).toContain(`${publicEndpoint}-lock`);
  });

  it("accepts concurrent connections from multiple MCP proxy sessions", async () => {
    const endpoint = uniqueEndpoint();
    let connectionCount = 0;
    let resolveConnections: (() => void) | undefined;
    const allConnected = new Promise<void>((resolve) => {
      resolveConnections = resolve;
    });
    const server = await startLocalIpcServer({
      endpoint,
      onConnection: (socket) => {
        connectionCount += 1;
        socket.on("data", (data) => socket.write(data));
        if (connectionCount === 2) resolveConnections?.();
      },
    });
    servers.push(server);

    const clients = await Promise.all([
      connectLocalIpc(endpoint),
      connectLocalIpc(endpoint),
    ]);
    sockets.push(...clients);
    await allConnected;

    const echoes = clients.map(async (client, index) => {
      const response = once(client, "data");
      client.write(`session-${index}\n`);
      return response;
    });

    await expect(Promise.all(echoes)).resolves.toHaveLength(2);
    expect(connectionCount).toBe(2);
  });

  it("keeps accepted sockets writable after the client half-closes", async () => {
    const endpoint = uniqueEndpoint();
    const server = await startLocalIpcServer({
      endpoint,
      onConnection: (socket) => {
        socket.once("error", () => {});
        socket.once("data", () => {
          setTimeout(() => socket.end("late-response\n"), 25);
        });
      },
    });
    servers.push(server);

    const client = await connectLocalIpc(endpoint);
    sockets.push(client);
    const response = once(client, "data");
    client.end("request\n");

    await expect(response).resolves.toEqual([expect.any(Buffer)]);
  });

  it.skipIf(process.platform === "win32")("recovers a stale Unix socket endpoint", async () => {
    const endpoint = uniqueEndpoint();
    const staleServer = createServer();
    staleServer.listen(endpoint);
    await once(staleServer, "listening");
    await new Promise<void>((resolve) => staleServer.close(() => resolve()));

    const replacement = await startLocalIpcServer({
      endpoint,
      onConnection: (socket) => socket.destroy(),
    });
    servers.push(replacement);
  });

  it.skipIf(process.platform === "win32")("does not remove a regular endpoint file", async () => {
    const endpoint = uniqueEndpoint();
    writeFileSync(endpoint, "keep this file");

    try {
      await expect(startLocalIpcServer({
        endpoint,
        onConnection: (socket) => socket.destroy(),
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(readFileSync(endpoint, "utf8")).toBe("keep this file");
    } finally {
      unlinkSync(endpoint);
    }
  });
});
