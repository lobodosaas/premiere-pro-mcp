import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectToLocalBroker,
  runLocalBrokerProxy,
  startLocalBroker,
  type LocalBroker,
} from "../../src/bridge/local-broker.js";
import { getLocalBrokerEndpoint, connectLocalIpc } from "../../src/bridge/local-ipc.js";

const TOKEN = "test-token-at-least-16-characters";
const brokers: LocalBroker[] = [];
const sockets: Socket[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function readLine(socket: Socket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function initialize(socket: Socket, id: number): Promise<Record<string, any>> {
  socket.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "local-broker-test", version: "1.0.0" },
    },
  })}\n`);
  return readLine(socket);
}

describe("local MCP broker", () => {
  it("serves multiple MCP proxy sessions through one UXP owner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "premiere-mcp-broker-"));
    tempDirs.push(tempDir);
    const broker = await startLocalBroker({
      bridgeOptions: { tempDir },
      uxpToken: TOKEN,
      uxpPort: 0,
      ipcEndpoint: getLocalBrokerEndpoint({ username: `broker-${randomUUID()}` }),
      toolPacks: "inspection",
    });
    brokers.push(broker);

    const clients = await Promise.all([
      connectLocalIpc(broker.endpoint),
      connectLocalIpc(broker.endpoint),
    ]);
    sockets.push(...clients);
    const responses = await Promise.all(clients.map((client, index) => initialize(client, index + 1)));

    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "premiere-pro-mcp" } } });
    expect(responses[1]).toMatchObject({ id: 2, result: { serverInfo: { name: "premiere-pro-mcp" } } });
    expect(broker.uxpBridge.getState()).toMatchObject({ status: "listening", connected: false });

    for (const client of clients) client.destroy();
    await once(broker, "idle");
  });

  it("starts one broker when no local endpoint is available", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "premiere-mcp-broker-"));
    tempDirs.push(tempDir);
    const endpoint = getLocalBrokerEndpoint({ username: `spawn-${randomUUID()}` });
    let brokerPromise: Promise<LocalBroker> | undefined;
    const spawnBroker = vi.fn(() => {
      brokerPromise = startLocalBroker({
        bridgeOptions: { tempDir },
        uxpToken: TOKEN,
        uxpPort: 0,
        ipcEndpoint: endpoint,
        toolPacks: "inspection",
      });
      void brokerPromise.then((broker) => brokers.push(broker));
    });

    const socket = await connectToLocalBroker({
      endpoint,
      connectTimeoutMs: 25,
      startTimeoutMs: 3_000,
      spawnBroker,
    });
    sockets.push(socket);

    expect(spawnBroker).toHaveBeenCalledOnce();
    expect(brokerPromise).toBeDefined();
    await expect(initialize(socket, 3)).resolves.toMatchObject({
      id: 3,
      result: { serverInfo: { name: "premiere-pro-mcp" } },
    });
  });

  it("forwards one stdio session without creating another UXP listener", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "premiere-mcp-broker-"));
    tempDirs.push(tempDir);
    const broker = await startLocalBroker({
      bridgeOptions: { tempDir },
      uxpToken: TOKEN,
      uxpPort: 0,
      ipcEndpoint: getLocalBrokerEndpoint({ username: `proxy-${randomUUID()}` }),
      toolPacks: "inspection",
    });
    brokers.push(broker);

    const input = new PassThrough();
    const output = new PassThrough();
    const outputLine = new Promise<Record<string, any>>((resolve, reject) => {
      let buffer = "";
      output.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
      });
      output.once("error", reject);
    });

    const proxy = runLocalBrokerProxy(
      { endpoint: broker.endpoint },
      { input, output },
    );
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "local-proxy-test", version: "1.0.0" },
      },
    })}\n`);

    await expect(outputLine).resolves.toMatchObject({
      id: 4,
      result: { serverInfo: { name: "premiere-pro-mcp" } },
    });
    expect(broker.uxpBridge.address().port).toBeGreaterThan(0);

    input.end();
    await expect(proxy).resolves.toBeUndefined();
  });

  it("keeps the proxy socket open for a response after stdin ends", async () => {
    const endpoint = getLocalBrokerEndpoint({ username: `half-close-${randomUUID()}` });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.once("error", () => {});
      socket.once("data", () => {
        setTimeout(() => socket.end('{"jsonrpc":"2.0","id":5,"result":{}}\n'), 25);
      });
    });
    server.listen(endpoint);
    await once(server, "listening");

    const input = new PassThrough();
    const output = new PassThrough();
    const outputLine = new Promise<Record<string, any>>((resolve, reject) => {
      let buffer = "";
      output.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
      });
      output.once("error", reject);
    });

    try {
      const proxy = runLocalBrokerProxy({ endpoint }, { input, output });
      input.write("request\n");
      input.end();

      await expect(outputLine).resolves.toMatchObject({ id: 5 });
      await expect(proxy).resolves.toBeUndefined();
    } finally {
      input.destroy();
      output.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes the broker socket when proxy output closes", async () => {
    const endpoint = getLocalBrokerEndpoint({ username: `output-close-${randomUUID()}` });
    let accepted: Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      accepted = socket;
      socket.once("end", () => socket.end());
    });
    server.listen(endpoint);
    await once(server, "listening");

    const input = new PassThrough();
    const output = new PassThrough();
    const proxy = runLocalBrokerProxy({ endpoint }, { input, output });
    await vi.waitFor(() => expect(accepted).toBeDefined());
    output.destroy();

    await expect(proxy).resolves.toBeUndefined();
    await vi.waitFor(() => expect(accepted?.destroyed).toBe(true));

    input.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
