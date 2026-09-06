#!/usr/bin/env node

// Stops only this checkout's MCP owners, then reports whether its configured
// UXP port is free. Proxy sessions are deliberately left untouched.
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { findHeartbeatOwnerIds } from "./stop-mcp-heartbeat.mjs";

const projectScript = resolve(fileURLToPath(new URL("../dist/index.js", import.meta.url)));

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function processQuery(scriptPath) {
  const target = scriptPath.replaceAll("/", "\\").toLowerCase();
  return [
    "$target = " + powershellQuote(target),
    "$scriptPattern = '(?i)(?:^|\\s)' + [regex]::Escape($target) + '(?=\\s|$)'",
    "$processes = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {",
    "  $commandLine = $_.CommandLine",
    "  $normalized = if ($commandLine) { $commandLine.Replace('/', '\\').ToLowerInvariant().Replace([string][char]34, '') } else { '' }",
    "  $normalized -match $scriptPattern -and $normalized -notmatch '(?i)(?:^|\\s)--proxy(?=\\s|$)'",
    "}",
    "$processes | ForEach-Object { $_.ProcessId }",
  ].join("\n");
}

function processIds(scriptPath) {
  if (process.platform !== "win32") return posixProcessIds(scriptPath);
  const output = runPowerShell(processQuery(scriptPath));
  return output
    ? output.split(/\r?\n/).map((value) => Number.parseInt(value, 10)).filter(Number.isInteger)
    : [];
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function posixProcessIds(scriptPath) {
  const target = scriptPath;
  const scriptPattern = new RegExp(`(?:^|\\s)${regexEscape(target)}(?=\\s|$)`);
  const proxyPattern = /(?:^|\s)--proxy(?=\s|$)/;
  const output = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8" });
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const executable = match[2].toLowerCase().replace(/\.exe$/, "");
    if (executable !== "node" && executable !== "nodejs") return [];
    const commandLine = match[3].replaceAll('"', "").replaceAll("'", "");
    if (!scriptPattern.test(commandLine) || proxyPattern.test(commandLine)) return [];
    return [Number.parseInt(match[1], 10)];
  });
}

function stopProcesses(ids, force) {
  if (ids.length === 0) return;
  if (process.platform !== "win32") {
    for (const id of ids) {
      try {
        process.kill(id, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // Process may have exited between the query and signal.
      }
    }
    return;
  }
  const forceFlag = force ? " -Force" : "";
  runPowerShell(ids.map((id) =>
    `Stop-Process -Id ${id}${forceFlag} -ErrorAction SilentlyContinue`,
  ).join("\n"));
}

async function waitForProcessExit(scriptPath, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let remaining = processIds(scriptPath);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    remaining = processIds(scriptPath);
  }
  return remaining;
}

function configuredPort() {
  const port = Number.parseInt(process.env.PREMIERE_UXP_PORT ?? "7777", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PREMIERE_UXP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

async function portIsInUse(portNumber) {
  if (process.platform === "win32") {
    return runPowerShell(
      `(Get-NetTCPConnection -LocalPort ${portNumber} -State Listen -ErrorAction SilentlyContinue) -ne $null`,
    ) === "True";
  }

  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port: portNumber });
    const finish = (inUse) => {
      socket.destroy();
      resolvePort(inUse);
    };
    socket.setTimeout(500, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function main() {
  const portNumber = configuredPort();
  let owners = [];
  try {
    owners = processIds(projectScript);
  } catch (error) {
    console.error("[stop:mcp] Owner query failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  try {
    // A detached broker can outlive its parent session and become invisible
    // to command-line matching (orphan, or unreadable command line). The
    // heartbeat names its exact validated owner, so reclaim that too.
    const heartbeat = await findHeartbeatOwnerIds();
    for (const warning of heartbeat.warnings) console.log(warning);
    for (const id of heartbeat.ids) {
      if (!owners.includes(id)) {
        owners.push(id);
        console.log(`[stop:mcp] Heartbeat reclaimed orphaned broker pid ${id}.`);
      }
    }
  } catch (error) {
    console.log("[stop:mcp] Heartbeat check skipped:", error instanceof Error ? error.message : String(error));
  }
  if (owners.length === 0) {
    console.log("[stop:mcp] No owned MCP broker or legacy server process found.");
  }
  if (owners.length > 0) {
    stopProcesses(owners, false);
    // A broker may be blocked in a host call. Escalate only for processes that
    // still match this exact checkout after a bounded graceful wait.
    const remaining = await waitForProcessExit(projectScript);
    if (remaining.length > 0) stopProcesses(remaining, true);
    console.log(`[stop:mcp] Stopped ${owners.length} owned MCP process(es): ${owners.join(", ")}`);
  }

  try {
    if (await portIsInUse(portNumber)) {
      console.log(`[stop:mcp] WARNING: port ${portNumber} is still in use by another process.`);
      process.exitCode = 1;
    } else {
      console.log(`[stop:mcp] Port ${portNumber} is free; next MCP broker can bind it cleanly.`);
    }
  } catch {
    console.log(`[stop:mcp] Port ${portNumber} status could not be checked.`);
  }
}

void main().catch((error) => {
  console.error("[stop:mcp] Failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
