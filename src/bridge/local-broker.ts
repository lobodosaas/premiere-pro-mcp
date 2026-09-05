import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import process from "node:process";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import {
  StdioServerTransport,
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { createServer } from "../server.js";
import {
  cleanupTempDir,
  type BridgeOptions,
} from "./file-bridge.js";
import {
  connectLocalIpc,
  getLocalBrokerEndpoint,
  getLocalBrokerLockEndpoint,
  startLocalIpcServer,
  type LocalIpcServer,
} from "./local-ipc.js";
import {
  UxpWebSocketBridge,
  type UxpConnectionState,
} from "./uxp-websocket-bridge.js";
import { getTelemetry, type Telemetry } from "../telemetry.js";
import { readServerBuildInfo, type ServerBuildInfo } from "../build-info.js";

const BROKER_START_TIMEOUT_MS = 8_000;
const BROKER_RETRY_DELAY_MS = 100;

export interface LocalBrokerOptions {
  bridgeOptions: BridgeOptions;
  uxpToken: string;
  uxpPort?: number;
  uxpPath?: string;
  ipcEndpoint?: string;
  toolPacks?: string;
  telemetry?: Telemetry;
  /** Build snapshot to advertise; captured from dist/ at startup when omitted. */
  buildInfo?: ServerBuildInfo;
}

export interface LocalBrokerState {
  endpoint: string;
  clients: number;
  uxp: UxpConnectionState;
  build: ServerBuildInfo;
}

export class LocalBroker extends EventEmitter {
  readonly endpoint: string;
  readonly uxpBridge: UxpWebSocketBridge;
  /** Build snapshot captured once at broker startup, never re-read. */
  readonly buildInfo: ServerBuildInfo;

  private readonly options: LocalBrokerOptions;
  private readonly telemetry: Telemetry;
  private lockServer: LocalIpcServer | null = null;
  private ipcServer: LocalIpcServer | null = null;
  private readonly clients = new Map<Socket, StdioServerHandle>();
  private closed = false;

  constructor(options: LocalBrokerOptions) {
    super();
    this.options = options;
    this.endpoint = options.ipcEndpoint ?? getLocalBrokerEndpoint();
    this.telemetry = options.telemetry ?? getTelemetry();
    const captured = options.buildInfo ?? readServerBuildInfo();
    this.buildInfo = { capturedAt: new Date().toISOString(), ...captured };
    this.uxpBridge = new UxpWebSocketBridge({
      token: options.uxpToken,
      port: options.uxpPort,
      path: options.uxpPath,
    });
  }

  async start(): Promise<this> {
    try {
      this.lockServer = await startLocalIpcServer({
        endpoint: getLocalBrokerLockEndpoint(this.endpoint),
        onConnection: (socket) => socket.destroy(),
      });
      cleanupTempDir(this.options.bridgeOptions);
      // Claim the owner endpoint before opening UXP. Concurrent proxy starts
      // then elect one broker without creating duplicate UXP listeners.
      await this.uxpBridge.start();
      this.ipcServer = await startLocalIpcServer({
        endpoint: this.endpoint,
        onConnection: (socket) => this.acceptClient(socket),
      });
      return this;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  state(): LocalBrokerState {
    return {
      endpoint: this.endpoint,
      clients: this.clients.size,
      uxp: this.uxpBridge.getState(),
      build: this.buildInfo,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ipcServer = this.ipcServer;
    this.ipcServer = null;
    await ipcServer?.close().catch(() => {});
    const clients = [...this.clients.entries()];
    await Promise.all(clients.map(([, handle]) => handle.close().catch(() => {})));
    for (const [socket] of clients) socket.destroy();
    this.clients.clear();
    await this.uxpBridge.stop();
    const lockServer = this.lockServer;
    this.lockServer = null;
    await lockServer?.close().catch(() => {});
    await this.telemetry.shutdown();
  }

  private acceptClient(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }

    const transport = new StdioServerTransport(socket, socket);
    const handle = serveStdio(
      () => createServer(this.options.bridgeOptions, {
        uxpBridge: this.uxpBridge,
        telemetry: this.telemetry,
        toolPacks: this.options.toolPacks,
        buildInfo: this.buildInfo,
      }),
      {
        transport,
        onerror: (error) => this.emit("clientError", error),
      },
    );
    this.clients.set(socket, handle);
    socket.once("end", () => {
      if (!socket.destroyed) socket.end();
    });
    socket.once("close", () => {
      this.clients.delete(socket);
      void handle.close().catch((error) => this.emit("clientError", error));
      if (this.clients.size === 0) this.emit("idle");
    });
  }
}

export async function startLocalBroker(options: LocalBrokerOptions): Promise<LocalBroker> {
  return new LocalBroker(options).start();
}

export interface LocalBrokerProxyOptions {
  endpoint?: string;
  connectTimeoutMs?: number;
  startTimeoutMs?: number;
  brokerScript?: string;
  environment?: NodeJS.ProcessEnv;
  spawnBroker?: () => void;
}

export interface LocalBrokerProxyStreams {
  input: Readable;
  output: Writable;
}

function spawnBrokerProcess(options: LocalBrokerProxyOptions): void {
  const brokerScript = options.brokerScript ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../index.js",
  );
  const environment = {
    ...(options.environment ?? process.env),
    ...(options.endpoint ? { PREMIERE_MCP_BROKER_ENDPOINT: options.endpoint } : {}),
  };
  const child = spawn(process.execPath, [brokerScript, "--broker"], {
    detached: true,
    stdio: "ignore",
    env: environment,
  });
  child.once("error", () => {});
  child.unref();
}

async function waitForBroker(
  endpoint: string,
  timeoutMs: number,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await connectLocalIpc(endpoint, Math.min(
        500,
        Math.max(1, deadline - Date.now()),
      ));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, BROKER_RETRY_DELAY_MS));
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Local Premiere MCP broker did not become ready${detail}`);
}

export async function connectToLocalBroker(
  options: LocalBrokerProxyOptions = {},
): Promise<Socket> {
  const endpoint = options.endpoint ?? getLocalBrokerEndpoint();
  const connectTimeoutMs = options.connectTimeoutMs ?? 500;
  const startTimeoutMs = options.startTimeoutMs ?? BROKER_START_TIMEOUT_MS;

  try {
    return await connectLocalIpc(endpoint, connectTimeoutMs);
  } catch {
    (options.spawnBroker ?? (() => spawnBrokerProcess({ ...options, endpoint })))();
    return waitForBroker(endpoint, startTimeoutMs);
  }
}

export async function runLocalBrokerProxy(
  options: LocalBrokerProxyOptions = {},
  streams: LocalBrokerProxyStreams = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> {
  const socket = await connectToLocalBroker(options);
  streams.input.pipe(socket);
  socket.pipe(streams.output);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let inputEnded = false;
    const onInputEnd = () => {
      inputEnded = true;
      socket.end();
    };
    const onInputClose = () => {
      if (!inputEnded) finish();
    };
    const onInputError = (error: Error) => finish(error);
    const onOutputError = (error: Error) => finish(error);
    const onOutputClose = () => finish();
    const onSocketError = (error: Error) => finish(error);
    const onSocketClose = () => finish();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      streams.input.off("end", onInputEnd);
      streams.input.off("close", onInputClose);
      streams.input.off("error", onInputError);
      streams.output.off("close", onOutputClose);
      streams.output.off("error", onOutputError);
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
      streams.input.unpipe(socket);
      socket.unpipe(streams.output);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    streams.input.once("end", onInputEnd);
    streams.input.once("close", onInputClose);
    streams.input.once("error", onInputError);
    streams.output.once("close", onOutputClose);
    streams.output.once("error", onOutputError);
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
  });
}
