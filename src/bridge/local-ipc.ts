import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\premiere-pro-mcp-";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface LocalIpcServer {
  endpoint: string;
  close(): Promise<void>;
}

export interface LocalIpcServerOptions {
  endpoint: string;
  onConnection: (socket: Socket) => void;
}

export interface LocalBrokerEndpointOptions {
  platform?: NodeJS.Platform;
  username?: string;
  tempDir?: string;
}

interface UnixSocketIdentity {
  dev: number;
  ino: number;
}

function endpointSuffix(username: string): string {
  return createHash("sha256").update(username, "utf8").digest("hex").slice(0, 16);
}

export function getLocalBrokerEndpoint(options: LocalBrokerEndpointOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const username = options.username ?? os.userInfo().username;
  const suffix = endpointSuffix(username);

  if (platform === "win32") return `${WINDOWS_PIPE_PREFIX}${suffix}`;

  const tempDir = options.tempDir ?? os.tmpdir();
  return path.join(tempDir, `premiere-pro-mcp-${suffix}.sock`);
}

export function getLocalBrokerLockEndpoint(
  endpoint: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `${endpoint}-lock` : `${endpoint}.lock`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function removeStaleUnixSocket(endpoint: string, expected?: UnixSocketIdentity): boolean {
  if (process.platform === "win32") return false;

  let before;
  try {
    before = lstatSync(endpoint);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }

  if (!before.isSocket() || (expected && (before.dev !== expected.dev || before.ino !== expected.ino))) {
    return false;
  }

  let after;
  try {
    after = lstatSync(endpoint);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  if (
    !after.isSocket()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || (expected && (after.dev !== expected.dev || after.ino !== expected.ino))
  ) return false;

  try {
    unlinkSync(endpoint);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function getUnixSocketIdentity(endpoint: string): UnixSocketIdentity | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const stats = lstatSync(endpoint);
    return stats.isSocket() ? { dev: stats.dev, ino: stats.ino } : undefined;
  } catch {
    return undefined;
  }
}

async function prepareStaleUnixSocket(endpoint: string, error: unknown): Promise<boolean> {
  if (process.platform === "win32" || errorCode(error) !== "EADDRINUSE") return false;

  try {
    const probe = await connectLocalIpc(endpoint, 100);
    probe.destroy();
    return false;
  } catch (probeError) {
    if (errorCode(probeError) !== "ECONNREFUSED") return false;
    return removeStaleUnixSocket(endpoint);
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function connectLocalIpc(
  endpoint: string,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<Socket> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Local IPC connection timeout must be a positive integer"));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Local IPC connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("connect", () => {
      cleanup();
      resolve(socket);
    });
    socket.once("error", onError);
  });
}

export async function startLocalIpcServer(
  options: LocalIpcServerOptions,
): Promise<LocalIpcServer> {
  const server = createServer({ allowHalfOpen: true });
  const sockets = new Set<Socket>();
  let endpointPrepared = false;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    options.onConnection(socket);
  });

  const listen = (): Promise<void> => new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.endpoint);
  });

  try {
    await listen();
  } catch (error) {
    if (endpointPrepared || !(await prepareStaleUnixSocket(options.endpoint, error))) {
      await closeServer(server);
      throw error;
    }
    endpointPrepared = true;
    try {
      await listen();
    } catch (retryError) {
      await closeServer(server);
      throw retryError;
    }
  }

  const ownedSocket = getUnixSocketIdentity(options.endpoint);

  return {
    endpoint: options.endpoint,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      if (ownedSocket) removeStaleUnixSocket(options.endpoint, ownedSocket);
    },
  };
}
