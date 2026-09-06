#!/usr/bin/env node

// Heartbeat fallback for stop:mcp: finds a broker that owns the IPC endpoint
// but is invisible to command-line matching (orphaned detached broker, or a
// process whose command line the caller cannot read). A pid is only returned
// when the OS confirms the exact recorded owner: same pid, same process start
// time, and the --broker argv marker. Anything ambiguous yields a warning,
// never a kill.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HEARTBEAT_FILE = "premiere-mcp-broker-heartbeat.json";
const BROKER_ARGV_MARKER = "--broker";

export function heartbeatPath(directory = tmpdir()) {
  return join(directory, HEARTBEAT_FILE);
}

function validHeartbeat(value) {
  return (
    !!value
    && typeof value === "object"
    && value.version === 1
    && Number.isInteger(value.pid)
    && Number.isInteger(value.startTimeMs)
    && typeof value.uxpPort === "number"
  );
}

function parseWmiDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d{3,4})?$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset = "+000"] = match;
  const abs = Math.abs(Number(offset));
  const offsetMinutes = (offset.startsWith("-") ? -1 : 1) * (Math.floor(abs / 100) * 60 + (abs % 100));
  return (
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    - offsetMinutes * 60_000
  );
}

export function defaultQueryOwner(pid) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (!output) return Promise.resolve(null);
      const record = JSON.parse(output);
      if (!Number.isInteger(record?.ProcessId) || record.ProcessId !== pid) return Promise.resolve(null);
      const startTimeMs = parseWmiDate(record.CreationDate);
      if (!Number.isFinite(startTimeMs)) return Promise.resolve(null);
      return Promise.resolve({
        pid,
        startTimeMs,
        commandLine: typeof record.CommandLine === "string" ? record.CommandLine : "",
      });
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\s+/g, " ").trim();
    if (!output) return Promise.resolve(null);
    const match = /^(\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}) (.*)$/.exec(output);
    if (!match || match[2].length === 0) return Promise.resolve(null);
    const startTimeMs = Date.parse(match[1]);
    if (!Number.isFinite(startTimeMs)) return Promise.resolve(null);
    return Promise.resolve({ pid, startTimeMs, commandLine: match[2] });
  } catch {
    return Promise.resolve(null);
  }
}

export async function findHeartbeatOwnerIds({ heartbeatFile, queryOwner = defaultQueryOwner } = {}) {
  const warnings = [];
  let heartbeat = null;
  try {
    heartbeat = JSON.parse(readFileSync(heartbeatFile ?? heartbeatPath(), "utf8"));
  } catch {
    return { ids: [], warnings };
  }
  if (!validHeartbeat(heartbeat)) return { ids: [], warnings };

  let owner;
  try {
    owner = await queryOwner(heartbeat.pid);
  } catch (error) {
    warnings.push(
      `[stop:mcp] Could not verify heartbeat owner pid ${heartbeat.pid} (${error instanceof Error ? error.message : String(error)}). Left untouched.`,
    );
    return { ids: [], warnings };
  }
  if (!owner) return { ids: [], warnings };
  if (owner.startTimeMs !== heartbeat.startTimeMs) return { ids: [], warnings };
  if (typeof owner.commandLine !== "string" || owner.commandLine.length === 0) {
    warnings.push(
      `[stop:mcp] Heartbeat owner pid ${heartbeat.pid} has an unreadable command line. Re-run elevated to reclaim it.`,
    );
    return { ids: [], warnings };
  }
  if (!owner.commandLine.includes(BROKER_ARGV_MARKER)) return { ids: [], warnings };
  return { ids: [heartbeat.pid], warnings };
}
