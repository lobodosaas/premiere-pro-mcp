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
  getBrokerHeartbeatPath,
  killBrokerProcess,
  queryBrokerOwnerProcess,
  readBrokerHeartbeat,
  removeBrokerHeartbeat,
  resolveStaleBroker,
  writeBrokerHeartbeat,
  type QueryBrokerOwner,
} from "./broker-heartbeat.js";
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

const BROKER_HEARTBEAT_INTERVAL_MS = 2_000;

const BROKER_HEARTBEAT_STALE_MS = 10_000;

const BROKER_UNRESPONSIVE_CODE = "BROKER_UNRESPONSIVE";

/** Structured endpoint failure: names the broker instead of a bare -32000. */
export class BrokerEndpointError extends Error {
  readonly code = BROKER_UNRESPONSIVE_CODE;
  readonly endpoint: string;
  readonly pid: number | null;
  readonly heartbeatAgeMs: number | null;

  constructor(endpoint: string, pid: number | null, heartbeatAgeMs: number | null) {
    super(
      `Premiere MCP broker is unresponsive at ${endpoint}`
      + (pid === null ? "" : ` (pid ${pid}`)
      + (heartbeatAgeMs === null ? "" : `, last heartbeat ${Math.round(heartbeatAgeMs / 1000)}s ago`)
      + (pid === null && heartbeatAgeMs === null ? "" : ")")
      + ". Run `npm run stop:mcp` in the checkout, restart the premiere-pro MCP, and retry.",
    );
    this.endpoint = endpoint;
    this.pid = pid;
    this.heartbeatAgeMs = heartbeatAgeMs;
  }
}

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
  /**
   * Broker liveness heartbeat. Enabled by default; pass `false` to disable
   * (tests) or `{ file, intervalMs }` to redirect it.
   */
  heartbeat?: false | { file?: string; intervalMs?: number };
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
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatFile: string | null = null;

  constructor(options: LocalBrokerOptions) {
    super();
    this.options = options;
    this.endpoint = options.ipcEndpoint ?? getLocalBrokerEndpoint();
    this.telemetry = options.telemetry ?? getTelemetry();
    const captured = options.buildInfo ?? readServerBuildInfo();
    this.buildInfo = Object.freeze({ capturedAt: new Date().toISOString(), ...captured });
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
      this.startHeartbeat();
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
    this.stopHeartbeat();
    await this.telemetry.shutdown();
  }

  private heartbeatConfig(): { file: string; intervalMs: number } | null {
    if (this.options.heartbeat === false) return null;
    return {
      file: this.options.heartbeat?.file ?? getBrokerHeartbeatPath(),
      intervalMs: this.options.heartbeat?.intervalMs ?? BROKER_HEARTBEAT_INTERVAL_MS,
    };
  }

  private writeHeartbeatOnce(file: string): void {
    try {
      const commit = this.buildInfo && typeof this.buildInfo.commit === "string"
        ? this.buildInfo.commit
        : null;
      writeBrokerHeartbeat(file, {
        pid: process.pid,
        startTimeMs: Date.now() - Math.round(process.uptime() * 1000),
        checkoutPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
        distCommit: commit,
        uxpPort: this.options.uxpPort ?? 7777,
      });
    } catch {
      // Heartbeat is advisory; a broker that cannot write temp must still serve.
    }
  }

  private startHeartbeat(): void {
    const config = this.heartbeatConfig();
    if (!config) return;
    this.heartbeatFile = config.file;
    this.writeHeartbeatOnce(config.file);
    this.heartbeatTimer = setInterval(() => this.writeHeartbeatOnce(config.file), config.intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatFile) {
      removeBrokerHeartbeat(this.heartbeatFile);
      this.heartbeatFile = null;
    }
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
  /** Max heartbeat age before a connected broker counts as a zombie. */
  heartbeatMaxAgeMs?: number;
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

export interface VerifyBrokerSocketOptions {
  nowMs?: number;
  heartbeatMaxAgeMs?: number;
  heartbeatFile?: string;
  readHeartbeat?: () => ReturnType<typeof readBrokerHeartbeat>;
  queryOwner?: QueryBrokerOwner;
  killProcess?: (pid: number) => Promise<void>;
}

export type BrokerSocketVerdict = { status: "healthy" } | { status: "reclaim"; pid: number };

/**
 * Confirm the broker behind a connected socket is alive. A validated zombie
 * (stale heartbeat + exact pid/start/marker match) is terminated so the proxy
 * can spawn a fresh broker; anything ambiguous keeps the socket untouched, so
 * the happy path and legacy brokers behave exactly as before.
 */
export async function verifyBrokerSocket(
  socket: Socket,
  options: VerifyBrokerSocketOptions = {},
): Promise<BrokerSocketVerdict> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.heartbeatMaxAgeMs ?? BROKER_HEARTBEAT_STALE_MS;
  const heartbeat = (options.readHeartbeat ?? (() => readBrokerHeartbeat(
    options.heartbeatFile ?? getBrokerHeartbeatPath(),
  )))();
  if (!heartbeat) return { status: "healthy" };
  const decision = await resolveStaleBroker(heartbeat, nowMs, {
    maxAgeMs,
    queryOwner: options.queryOwner ?? queryBrokerOwnerProcess,
  });
  if (decision.action !== "kill") return { status: "healthy" };
  socket.destroy();
  await (options.killProcess ?? killBrokerProcess)(decision.pid);
  return { status: "reclaim", pid: decision.pid };
}

export async function connectToLocalBroker(
  options: LocalBrokerProxyOptions = {},
): Promise<Socket> {
  const endpoint = options.endpoint ?? getLocalBrokerEndpoint();
  const connectTimeoutMs = options.connectTimeoutMs ?? 500;
  const startTimeoutMs = options.startTimeoutMs ?? BROKER_START_TIMEOUT_MS;
  const spawnFresh = () => {
    (options.spawnBroker ?? (() => spawnBrokerProcess({ ...options, endpoint })))();
    return waitForBroker(endpoint, startTimeoutMs);
  };

  try {
    const socket = await connectLocalIpc(endpoint, connectTimeoutMs);
    // Verification is advisory: it must never break a working connection.
    const verdict = await verifyBrokerSocket(socket, {
      heartbeatMaxAgeMs: options.heartbeatMaxAgeMs,
    }).catch(() => ({ status: "healthy" }) as BrokerSocketVerdict);
    if (verdict.status === "healthy") return socket;
  } catch {
    // No listener: fall through and spawn a fresh broker below.
  }

  try {
    return await spawnFresh();
  } catch {
    const heartbeat = readBrokerHeartbeat(getBrokerHeartbeatPath());
    const now = Date.now();
    throw new BrokerEndpointError(
      endpoint,
      heartbeat?.pid ?? null,
      heartbeat ? now - heartbeat.lastTickMs : null,
    );
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
