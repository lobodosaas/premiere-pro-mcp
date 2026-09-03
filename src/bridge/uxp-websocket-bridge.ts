import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const LOOPBACK_HOST = "127.0.0.1";
const SUPPORTED_PROTOCOLS = new Set([1, 2]);
const COMMAND_NAME = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const DIAGNOSTIC_PHASES = new Set([
  "received",
  "parsed",
  "host.project.started",
  "host.project.completed",
  "host.sequence.started",
  "host.sequence.completed",
  "host.playhead.started",
  "host.playhead.completed",
  "host.playhead.timed_out",
  "serialized",
  "sent",
  "failed",
]);
const MAX_DIAGNOSTIC_RECORDS = 64;

export interface UxpBridgeOptions {
  token: string;
  port?: number;
  path?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface UxpCapability {
  supported: boolean;
  [key: string]: unknown;
}

export interface UxpRequestOptions {
  /** Do not let the bridge timeout before a bounded host-side wait can settle. */
  minimumTimeoutMs?: number;
}

export interface UxpHello {
  backend: "uxp";
  protocolVersion: number;
  commands: Record<string, UxpCapability>;
  [key: string]: unknown;
}

interface UxpDiagnosticRecord {
  sequence: number;
  command: string;
  requestIdPresent: boolean;
  phase: string;
}

interface UxpDiagnostics {
  records: UxpDiagnosticRecord[];
  capacity: number;
  dropped: number;
}

export type UxpConnectionState =
  | { status: "stopped" | "listening"; connected: false }
  | {
      status: "connected";
      connected: true;
      protocolVersion: number;
      capabilities: UxpHello;
      connectedAt: string;
      diagnostics?: UxpDiagnostics;
    };

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class UxpBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UxpBridgeError";
  }
}

function secureTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("UXP bridge port must be an integer between 0 and 65535");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateDiagnostics(value: unknown): UxpDiagnostics | null {
  if (!isRecord(value) || !Array.isArray(value.records)) return null;
  if (value.records.length > MAX_DIAGNOSTIC_RECORDS) return null;

  const capacity = value.capacity;
  const dropped = value.dropped;
  if (
    typeof capacity !== "number" ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_DIAGNOSTIC_RECORDS ||
    typeof dropped !== "number" ||
    !Number.isSafeInteger(dropped) ||
    dropped < 0
  ) return null;

  const records: UxpDiagnosticRecord[] = [];
  for (const record of value.records) {
    if (!isRecord(record)) return null;
    const sequence = record.sequence;
    const command = record.command;
    const requestIdPresent = record.requestIdPresent;
    const phase = record.phase;
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof command !== "string" ||
      command.length < 1 ||
      command.length > 128 ||
      !COMMAND_NAME.test(command) ||
      typeof requestIdPresent !== "boolean" ||
      typeof phase !== "string" ||
      !DIAGNOSTIC_PHASES.has(phase)
    ) return null;
    records.push({ sequence, command, requestIdPresent, phase });
  }
  return { records, capacity, dropped };
}

/**
 * Authenticated loopback WebSocket server used only by the local Premiere UXP
 * panel. It never binds a LAN/WAN interface and does not silently fall back to
 * CEP after a UXP command has been sent.
 */
export class UxpWebSocketBridge extends EventEmitter {
  private readonly options: Required<UxpBridgeOptions>;
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private hello: UxpHello | null = null;
  private connectedAt: string | null = null;
  private diagnostics: UxpDiagnostics | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: UxpBridgeOptions) {
    super();
    if (!options.token || options.token.length < 16) {
      throw new Error("PREMIERE_UXP_TOKEN must contain at least 16 characters");
    }
    this.options = {
      token: options.token,
      port: validPort(options.port ?? 7777),
      path: options.path ?? "/uxp",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
    };
    if (!this.options.path.startsWith("/")) {
      throw new Error("UXP bridge path must begin with '/'");
    }
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const httpServer = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      const authorized =
        url.pathname === this.options.path &&
        secureTokenEqual(url.searchParams.get("token") ?? "", this.options.token);
      if (!authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (client) => {
        wsServer.emit("connection", client, request);
      });
    });
    wsServer.on("connection", (client) => this.acceptConnection(client));

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(this.options.port, LOOPBACK_HOST, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    this.httpServer = httpServer;
    this.wsServer = wsServer;
    this.emit("listening", this.address());
  }

  address(): { host: string; port: number; path: string } {
    const address = this.httpServer?.address();
    return {
      host: LOOPBACK_HOST,
      port: typeof address === "object" && address ? address.port : this.options.port,
      path: this.options.path,
    };
  }

  getState(): UxpConnectionState {
    if (this.socket?.readyState === WebSocket.OPEN && this.hello && this.connectedAt) {
      const state: Extract<UxpConnectionState, { status: "connected" }> = {
        status: "connected",
        connected: true,
        protocolVersion: this.hello.protocolVersion,
        capabilities: this.hello,
        connectedAt: this.connectedAt,
      };
      if (this.diagnostics) {
        state.diagnostics = {
          records: this.diagnostics.records.map((record) => ({ ...record })),
          capacity: this.diagnostics.capacity,
          dropped: this.diagnostics.dropped,
        };
      }
      return state;
    }
    return {
      status: this.httpServer ? "listening" : "stopped",
      connected: false,
    };
  }

  async request(
    command: string,
    args: Record<string, unknown> = {},
    requestOptions: UxpRequestOptions = {},
  ): Promise<unknown> {
    const socket = this.socket;
    const hello = this.hello;
    if (!socket || socket.readyState !== WebSocket.OPEN || !hello) {
      throw new UxpBridgeError("UXP_NOT_CONNECTED", "Premiere UXP bridge is not connected");
    }
    if (hello.commands[command]?.supported !== true) {
      throw new UxpBridgeError(
        "UXP_COMMAND_UNSUPPORTED",
        `Connected Premiere host does not support UXP command '${command}'`,
      );
    }

    const minimumTimeoutMs = requestOptions.minimumTimeoutMs ?? 0;
    if (!Number.isInteger(minimumTimeoutMs) || minimumTimeoutMs < 0) {
      throw new Error("UXP minimum request timeout must be a non-negative integer");
    }
    const requestTimeoutMs = Math.max(this.options.requestTimeoutMs, minimumTimeoutMs);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new UxpBridgeError("UXP_TIMEOUT", `UXP command '${command}' timed out`));
      }, requestTimeoutMs);
      this.pending.set(requestId, { command, resolve, reject, timer });
      socket.send(JSON.stringify({
        protocolVersion: hello.protocolVersion,
        type: "command",
        requestId,
        command,
        args,
      }), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new UxpBridgeError("UXP_SEND_FAILED", error.message));
      });
    });
  }

  async stop(): Promise<void> {
    this.clearConnection(new UxpBridgeError("UXP_STOPPED", "UXP bridge stopped"));
    const wsServer = this.wsServer;
    const httpServer = this.httpServer;
    this.wsServer = null;
    this.httpServer = null;
    if (wsServer) {
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }

  private acceptConnection(client: WebSocket): void {
    if (this.socket) {
      this.clearConnection(
        new UxpBridgeError("UXP_RECONNECTED", "Premiere UXP bridge reconnected"),
      );
    }
    this.socket = client;
    this.hello = null;
    this.connectedAt = null;
    this.handshakeTimer = setTimeout(() => {
      client.close(1008, "Versioned hello required");
    }, this.options.handshakeTimeoutMs);
    client.on("message", (data) => this.handleMessage(client, data.toString()));
    client.on("close", () => {
      if (client !== this.socket) return;
      this.clearConnection(
        new UxpBridgeError("UXP_DISCONNECTED", "Premiere UXP bridge disconnected"),
      );
      this.emit("disconnected");
    });
    client.on("error", (error) => this.emit("clientError", error));
  }

  private handleMessage(client: WebSocket, raw: string): void {
    if (client !== this.socket) return;
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      client.close(1007, "Invalid JSON");
      return;
    }

    if (!this.hello) {
      const hello = message?.type === "hello" ? message.payload : null;
      if (
        !hello ||
        hello.backend !== "uxp" ||
        !SUPPORTED_PROTOCOLS.has(message.protocolVersion) ||
        hello.protocolVersion !== message.protocolVersion ||
        !hello.commands ||
        typeof hello.commands !== "object" ||
        Array.isArray(hello.commands)
      ) {
        client.close(1008, "Unsupported UXP handshake");
        return;
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.hello = hello as UxpHello;
      this.connectedAt = new Date().toISOString();
      this.emit("connected", this.getState());
      return;
    }

    if (message?.protocolVersion !== this.hello.protocolVersion) {
      client.close(1008, "Protocol version changed");
      return;
    }
    if (message?.type === "event") {
      if (message.payload?.name === "premiere.bridge.command.trace") {
        const diagnostics = validateDiagnostics(message.payload.diagnostic);
        if (diagnostics) this.diagnostics = diagnostics;
      }
      this.emit("event", message.payload);
      return;
    }
    if (message?.type !== "result" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.payload?.ok === true) {
      pending.resolve(message.payload.result);
    } else {
      const error = message.payload?.error;
      pending.reject(new UxpBridgeError(
        error?.code ?? "UXP_COMMAND_FAILED",
        error?.message ?? `UXP command '${pending.command}' failed`,
      ));
    }
  }

  private clearConnection(error: Error): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.hello = null;
    this.connectedAt = null;
    this.diagnostics = null;
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
