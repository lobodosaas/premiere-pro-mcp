import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Broker liveness heartbeat.
 *
 * The detached broker owns a single machine-wide IPC endpoint, so a dead or
 * wedged broker squats the pipe and every new proxy fails. The heartbeat file
 * lets a fresh proxy (or stop:mcp) tell "live broker" from "zombie" and, when
 * the recorded owner provably matches, reclaim the endpoint. Kills are only
 * ever authorized against an exact pid + process-start-time + `--broker`
 * argv-marker match, so PID reuse can never nuke an unrelated process.
 */

export const BROKER_HEARTBEAT_VERSION = 1;
export const BROKER_HEARTBEAT_FILE = "premiere-mcp-broker-heartbeat.json";
export const BROKER_ARGV_MARKER = "--broker";
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export interface BrokerHeartbeat {
  version: number;
  pid: number;
  startTimeMs: number;
  checkoutPath: string;
  distCommit: string | null;
  uxpPort: number;
  lastTickMs: number;
}

export type BrokerHeartbeatFields = Omit<BrokerHeartbeat, "version" | "lastTickMs"> & {
  lastTickMs?: number;
};

export function getBrokerHeartbeatPath(directory: string = tmpdir()): string {
  return join(directory, BROKER_HEARTBEAT_FILE);
}

function isValidHeartbeat(value: unknown): value is BrokerHeartbeat {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === BROKER_HEARTBEAT_VERSION
    && Number.isInteger(record.pid)
    && Number.isInteger(record.startTimeMs)
    && typeof record.checkoutPath === "string"
    && (typeof record.distCommit === "string" || record.distCommit === null)
    && Number.isInteger(record.uxpPort)
    && Number.isInteger(record.lastTickMs)
  );
}

export function writeBrokerHeartbeat(
  file: string,
  fields: BrokerHeartbeatFields,
): BrokerHeartbeat {
  const record: BrokerHeartbeat = {
    version: BROKER_HEARTBEAT_VERSION,
    pid: fields.pid,
    startTimeMs: fields.startTimeMs,
    checkoutPath: fields.checkoutPath,
    distCommit: fields.distCommit,
    uxpPort: fields.uxpPort,
    lastTickMs: fields.lastTickMs ?? Date.now(),
  };
  const staging = `${file}.${randomUUID()}.tmp`;
  writeFileSync(staging, JSON.stringify(record), "utf8");
  renameSync(staging, file);
  return record;
}

export function readBrokerHeartbeat(file: string): BrokerHeartbeat | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isValidHeartbeat(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeBrokerHeartbeat(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone; nothing to reclaim.
  }
}

export function isHeartbeatLive(
  heartbeat: BrokerHeartbeat,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const age = nowMs - heartbeat.lastTickMs;
  return age >= -CLOCK_SKEW_TOLERANCE_MS && age <= maxAgeMs;
}

export interface BrokerOwnerInfo {
  pid: number;
  startTimeMs: number;
  commandLine: string;
}

export type QueryBrokerOwner = (pid: number) => Promise<BrokerOwnerInfo | null>;

export type StaleBrokerAction = "keep" | "kill" | "stale-no-owner" | "unknown";

export interface StaleBrokerDecision {
  action: StaleBrokerAction;
  pid: number;
}

export interface ResolveStaleBrokerOptions {
  maxAgeMs: number;
  queryOwner: QueryBrokerOwner;
}

function ownerMatches(heartbeat: BrokerHeartbeat, owner: BrokerOwnerInfo): boolean {
  return (
    owner.pid === heartbeat.pid
    && owner.startTimeMs === heartbeat.startTimeMs
    && owner.commandLine.includes(BROKER_ARGV_MARKER)
  );
}

/**
 * Decide what to do about a recorded broker. Live heartbeats are always kept.
 * A stale heartbeat authorizes a kill only when the OS confirms the exact
 * recorded owner still holds the pid; anything ambiguous keeps hands off.
 */
export async function resolveStaleBroker(
  heartbeat: BrokerHeartbeat,
  nowMs: number,
  options: ResolveStaleBrokerOptions,
): Promise<StaleBrokerDecision> {
  if (isHeartbeatLive(heartbeat, nowMs, options.maxAgeMs)) {
    return { action: "keep", pid: heartbeat.pid };
  }
  let owner: BrokerOwnerInfo | null;
  try {
    owner = await options.queryOwner(heartbeat.pid);
  } catch {
    return { action: "unknown", pid: heartbeat.pid };
  }
  if (!owner) return { action: "stale-no-owner", pid: heartbeat.pid };
  return ownerMatches(heartbeat, owner)
    ? { action: "kill", pid: heartbeat.pid }
    : { action: "keep", pid: heartbeat.pid };
}

export function parseWin32OwnerRecord(record: unknown): BrokerOwnerInfo | null {
  if (!record || typeof record !== "object") return null;
  const { ProcessId, CreationDate, CommandLine } = record as Record<string, unknown>;
  if (typeof ProcessId !== "number" || !Number.isInteger(ProcessId)) return null;
  if (typeof CreationDate !== "string") return null;
  // WMI datetime: yyyymmddHHMMSS.mmmmmm+UUU (minutes offset from UTC).
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d{3,4})?$/.exec(CreationDate);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset = "+000"] = match;
  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetMinutes = sign * (Math.floor(Math.abs(Number(offset)) / 100) * 60 + (Math.abs(Number(offset)) % 100));
  const startTimeMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  ) - offsetMinutes * 60_000;
  if (!Number.isFinite(startTimeMs)) return null;
  return {
    pid: ProcessId,
    startTimeMs,
    commandLine: typeof CommandLine === "string" ? CommandLine : "",
  };
}

export function parsePosixOwnerRecord(line: string): BrokerOwnerInfo | null {
  const normalized = line.replace(/\s+/g, " ").trim();
  // `ps -o lstart= -o args=`: "Fri Sep 5 19:07:37 2026 node /repo/dist/index.js --broker".
  const match = /^(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}) (.*)$/.exec(normalized);
  if (!match) return null;
  const startTimeMs = Date.parse(match[1].replace(/(\w{3} \w{3}) +(\d)/, "$1 0$2"));
  if (!Number.isFinite(startTimeMs) || match[2].length === 0) return null;
  return { pid: -1, startTimeMs, commandLine: match[2] };
}

/**
 * Identify the OS owner of a pid for zombie validation. Returns null when the
 * process is gone or unreadable — never throws, so callers degrade to
 * "unknown" instead of breaking the happy path.
 */
export async function queryBrokerOwnerProcess(pid: number): Promise<BrokerOwnerInfo | null> {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (!output) return null;
      const parsed: unknown = JSON.parse(output);
      const record = parseWin32OwnerRecord(parsed);
      return record && record.pid === pid ? record : null;
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!output) return null;
    const parsed = parsePosixOwnerRecord(output);
    return parsed ? { ...parsed, pid } : null;
  } catch {
    return null;
  }
}

/** Terminate a pid that resolveStaleBroker already validated. Throws on failure. */
export async function killBrokerProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return;
  }
  process.kill(pid, "SIGKILL");
}
