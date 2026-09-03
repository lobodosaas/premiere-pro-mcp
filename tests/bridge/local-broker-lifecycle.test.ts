import { once } from "node:events";
import { createServer, connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  serveStdio: vi.fn(),
  uxpStarts: 0,
  blockNextStop: false,
  uxpStopGate: Promise.resolve(),
  uxpStopStarted: undefined as (() => void) | undefined,
}));

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class {},
  serveStdio: mocks.serveStdio,
}));

vi.mock("../../src/bridge/uxp-websocket-bridge.js", () => ({
  UxpWebSocketBridge: class {
    async start() {
      mocks.uxpStarts += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    async stop() {
      if (!mocks.blockNextStop) return;
      mocks.blockNextStop = false;
      mocks.uxpStopStarted?.();
      await mocks.uxpStopGate;
    }
    address() { return { host: "127.0.0.1", port: 7777, path: "/uxp" }; }
    getState() { return { status: "listening", connected: false }; }
  },
}));

import { LocalBroker } from "../../src/bridge/local-broker.js";
import { connectLocalIpc, getLocalBrokerEndpoint } from "../../src/bridge/local-ipc.js";

const TOKEN = "test-token-at-least-16-characters";
const brokers: LocalBroker[] = [];
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  mocks.close.mockClear();
  mocks.serveStdio.mockReset();
  mocks.serveStdio.mockReturnValue({ close: mocks.close });
  mocks.uxpStarts = 0;
  mocks.blockNextStop = false;
  mocks.uxpStopGate = Promise.resolve();
  mocks.uxpStopStarted = undefined;
});

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("local broker client lifecycle", () => {
  it("closes the MCP session when its IPC socket closes", async () => {
    const broker = new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN });
    brokers.push(broker);
    const server = createServer((socket) => {
      (broker as any).acceptClient(socket);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const client = connect(address.port, "127.0.0.1");
    await once(client, "connect");
    client.destroy();

    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  });

  it("destroys accepted IPC sockets when the broker closes", async () => {
    const broker = new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN });
    brokers.push(broker);
    const server = createServer((socket) => {
      (broker as any).acceptClient(socket);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const client = connect(address.port, "127.0.0.1");
    await once(client, "connect");
    const closed = once(client, "close");

    await broker.close();
    await closed;
  });

  it("claims IPC ownership before starting UXP during concurrent startup", async () => {
    const endpoint = getLocalBrokerEndpoint({ username: `race-${Date.now()}` });
    const first = new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN, ipcEndpoint: endpoint });
    const second = new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN, ipcEndpoint: endpoint });

    const results = await Promise.allSettled([first.start(), second.start()]);
    const successful = results.filter((result) => result.status === "fulfilled");
    expect(successful).toHaveLength(1);
    expect(mocks.uxpStarts).toBe(1);

    if (successful[0]?.status === "fulfilled") {
      brokers.push(successful[0].value);
    }
  });

  it("does not publish the proxy endpoint until UXP startup completes", async () => {
    const endpoint = getLocalBrokerEndpoint({ username: `early-${Date.now()}` });
    const broker = new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN, ipcEndpoint: endpoint });
    const startPromise = broker.start();

    await expect(connectLocalIpc(endpoint, 5)).rejects.toThrow();
    expect(mocks.serveStdio).not.toHaveBeenCalled();

    await startPromise;
    brokers.push(broker);
    const client = await connectLocalIpc(endpoint);
    await vi.waitFor(() => expect(mocks.serveStdio).toHaveBeenCalledOnce());
    client.destroy();
  });

  it("keeps the owner lock until the UXP listener has stopped", async () => {
    const endpoint = getLocalBrokerEndpoint({ username: `close-race-${Date.now()}` });
    const broker = await new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN, ipcEndpoint: endpoint }).start();

    let releaseStop!: () => void;
    mocks.blockNextStop = true;
    mocks.uxpStopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopStarted = new Promise<void>((resolve) => { mocks.uxpStopStarted = resolve; });
    const closing = broker.close();
    await stopStarted;

    const contender = new LocalBroker({ bridgeOptions: {}, uxpToken: TOKEN, ipcEndpoint: endpoint });
    await expect(contender.start()).rejects.toThrow();

    releaseStop();
    await closing;

    const replacement = await new LocalBroker({
      bridgeOptions: {},
      uxpToken: TOKEN,
      ipcEndpoint: endpoint,
    }).start();
    brokers.push(replacement);
  });
});
