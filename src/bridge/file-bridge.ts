import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, renameSync, statSync, chmodSync, watch, FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getHelpersSource, helpersFileName, buildBootstrap } from "./script-builder.js";

const DEFAULT_TEMP_DIR = join(tmpdir(), "premiere-mcp-bridge");
const POLL_FALLBACK_MS = 250;
const DEFAULT_TIMEOUT_MS = 30000;
const STALE_PROTOCOL_FILE_MS = 60_000;
const OWNER_LEASE_PREFIX = "bridge-owner_";
const OWNER_LEASE_VERSION = 1;
const OWNER_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const processOwnerId = randomUUID();
const bridgeOwnerIds = new WeakMap<object, string>();
export const BRIDGE_HEARTBEAT_FILE = "bridge-heartbeat.json";
export const BRIDGE_HEARTBEAT_STALE_MS = 3_000;

export interface BridgeOptions {
  tempDir?: string;
  timeoutMs?: number;
  /**
   * Reject a health-style command without publishing it when a current CEP
   * connector explicitly reports that it is waiting or its heartbeat is stale.
   * A missing heartbeat remains compatible with older installed connectors.
   */
  failFastOnUnreadyHeartbeat?: boolean;
}

export interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type BridgeLivenessState = "running" | "waiting" | "stale" | "unknown";

export interface BridgeLiveness {
  state: BridgeLivenessState;
  ageMs: number | null;
}

interface OwnerStates {
  active: Set<string>;
  dead: Set<string>;
}

/**
 * Create the bridge temp dir private to this user, and — critically — refuse to trust
 * one we didn't create.
 *
 * The dir sits at a predictable, world-accessible path (e.g. /tmp/premiere-mcp-bridge)
 * and the CEP panel executes ANY cmd_*.jsx it finds there, inside Premiere, as the
 * logged-in user. On a shared machine another user could pre-create that path and drop
 * command files, or read the res_*.json we write (which contain project data). And
 * mkdirSync({recursive:true}) is a no-op on an existing dir — it does NOT re-apply the
 * mode — so "create it 0o700" alone does not protect against a dir that was already there.
 *
 * So: if it exists, verify it's ours and lock its permissions down; if it isn't ours,
 * fail loudly rather than executing whatever an attacker staged in it.
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }

  // POSIX only — Windows doesn't model uid/mode the same way, and its per-user temp
  // dir isn't world-writable to begin with.
  if (process.platform === "win32") return;

  const st = statSync(dir);
  const myUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (myUid !== undefined && st.uid !== myUid) {
    throw new Error(
      `Bridge temp dir ${dir} is owned by uid ${st.uid}, not this user (${myUid}). ` +
        `Refusing to use it — another user may have staged command files. ` +
        `Set PREMIERE_TEMP_DIR to a path only you control.`
    );
  }

  // Clamp to owner-only, in case it was created with looser perms before this fix.
  if ((st.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

export function getTempDir(options?: BridgeOptions): string {
  return options?.tempDir || process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
}

/**
 * Inspect the CEP panel's small, content-free heartbeat. This never creates a
 * directory or reads command, response, project, or media data. Unknown is
 * intentionally non-fatal so a server upgrade stays compatible with older CEP
 * panels that do not publish a heartbeat yet.
 */
export function getBridgeLiveness(
  options?: BridgeOptions,
  nowMs = Date.now(),
): BridgeLiveness {
  const heartbeatPath = join(getTempDir(options), BRIDGE_HEARTBEAT_FILE);
  try {
    if (!existsSync(heartbeatPath)) return { state: "unknown", ageMs: null };
    const raw = readFileSync(heartbeatPath, "utf-8");
    const heartbeat = JSON.parse(raw) as Record<string, unknown>;
    if (
      heartbeat.protocolVersion !== 1 ||
      (heartbeat.state !== "running" && heartbeat.state !== "waiting")
    ) {
      return { state: "unknown", ageMs: null };
    }
    const ageMs = Math.max(0, nowMs - statSync(heartbeatPath).mtimeMs);
    return ageMs > BRIDGE_HEARTBEAT_STALE_MS
      ? { state: "stale", ageMs }
      : { state: heartbeat.state, ageMs };
  } catch {
    return { state: "unknown", ageMs: null };
  }
}

function heartbeatFailure(liveness: BridgeLiveness): CommandResult | null {
  if (liveness.state === "waiting") {
    return {
      success: false,
      error:
        "The CEP connector is open but not running. In Premiere Pro, open Window > Extensions > MCP Bridge, wait for it to finish starting, then retry once.",
    };
  }
  if (liveness.state === "stale") {
    return {
      success: false,
      error:
        "The CEP connector heartbeat is stale. Reopen Window > Extensions > MCP Bridge in Premiere Pro, dismiss any blocking dialog, and retry once after it reports running.",
    };
  }
  return null;
}

/**
 * Make sure this server version's helpers file exists in the temp dir, and return
 * the bootstrap line each command must carry so the CEP-side engine loads it once.
 */
function ensureHelpers(tempDir: string): string {
  const helpersPath = join(tempDir, helpersFileName());
  if (!existsSync(helpersPath)) {
    writeFileSync(helpersPath, getHelpersSource(), "utf-8");
  }
  return buildBootstrap(helpersPath);
}

/**
 * Send a command (ExtendScript) to the CEP plugin and wait for a response.
 * 
 * Protocol:
 * 1. Write the script to a staging file, then atomically publish it as
 *    <tempDir>/cmd_<owner>_<id>.jsx. The CEP panel only sees complete commands.
 * 2. CEP plugin picks it up, executes, writes result to <tempDir>/res_<owner>_<id>.json
 * 3. We poll for the response file and parse it.
 */
export async function sendCommand(
  script: string,
  options?: BridgeOptions
): Promise<CommandResult> {
  const tempDir = getTempDir(options);
  const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  ensureDir(tempDir);

  if (options?.failFastOnUnreadyHeartbeat) {
    const failure = heartbeatFailure(getBridgeLiveness(options));
    if (failure) return failure;
  }

  const ownerId = getBridgeOwnerId(options);
  ensureOwnerLease(tempDir, ownerId);
  const id = `${ownerId}_${randomUUID()}`;
  const cmdFile = join(tempDir, `cmd_${id}.jsx`);
  const stagedCmdFile = `${cmdFile}.staged`;
  const resFile = join(tempDir, `res_${id}.json`);
  const busyFile = join(tempDir, `busy_${id}.json`);

  // Validate script
  validateScript(script);

  try {
    // Write a complete command before its .jsx name makes it visible to CEP.
    // renameSync is atomic when both paths are in the bridge directory.
    writeFileSync(stagedCmdFile, `${ensureHelpers(tempDir)}
${script}`, "utf-8");
    renameSync(stagedCmdFile, cmdFile);

    return await pollForResponse(resFile, busyFile, timeoutMs);
  } finally {
    safeUnlink(stagedCmdFile);
    safeUnlink(cmdFile);
    safeUnlink(resFile);
    safeUnlink(busyFile);
  }
}

function validateScript(script: string, allowUnsafe = false): void {
  const MAX_SCRIPT_SIZE = 500 * 1024; // 500KB
  if (Buffer.byteLength(script, "utf-8") > MAX_SCRIPT_SIZE) {
    throw new Error("Script exceeds 500KB size limit");
  }

  if (allowUnsafe) return;

  // Block dangerous patterns in user-provided parameters
  // Note: we don't block these in our own generated code, only check for injection
  const dangerousPatterns = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bSystem\s*\.\s*callSystem\s*\(/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(script)) {
      throw new Error(`Script contains blocked pattern: ${pattern.source}`);
    }
  }
}

/**
 * Send a raw/custom ExtendScript allowing all patterns (for LLM-authored scripts).
 * Still enforces size limit. The script should already include helpers via buildToolScript.
 */
export async function sendRawCommand(
  script: string,
  options?: BridgeOptions
): Promise<CommandResult> {
  const tempDir = getTempDir(options);
  const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  ensureDir(tempDir);

  if (options?.failFastOnUnreadyHeartbeat) {
    const failure = heartbeatFailure(getBridgeLiveness(options));
    if (failure) return failure;
  }

  const ownerId = getBridgeOwnerId(options);
  ensureOwnerLease(tempDir, ownerId);
  const id = `${ownerId}_${randomUUID()}`;
  const cmdFile = join(tempDir, `cmd_${id}.jsx`);
  const stagedCmdFile = `${cmdFile}.staged`;
  const resFile = join(tempDir, `res_${id}.json`);
  const busyFile = join(tempDir, `busy_${id}.json`);

  validateScript(script, true);
  try {
    writeFileSync(stagedCmdFile, `${ensureHelpers(tempDir)}
${script}`, "utf-8");
    renameSync(stagedCmdFile, cmdFile);
    return await pollForResponse(resFile, busyFile, timeoutMs);
  } finally {
    safeUnlink(stagedCmdFile);
    safeUnlink(cmdFile);
    safeUnlink(resFile);
    safeUnlink(busyFile);
  }
}

async function pollForResponse(
  resFile: string,
  busyFile: string,
  timeoutMs: number
): Promise<CommandResult> {
  const start = Date.now();
  // The CEP plugin writes busy_<id>.json every ~2s while evalScript is in flight.
  // A fresh busy file past the deadline means Premiere accepted the script but hasn't
  // returned — nearly always a modal dialog blocking the scripting engine, or a
  // genuinely long operation — so we keep waiting up to a hard cap instead of
  // misreporting "is the plugin running?".
  const hardCapMs = Math.max(timeoutMs * 4, 120_000);
  let sawBusy = false;
  let lastResponseParseError: string | undefined;

  const busyIsFresh = (): boolean => {
    try {
      if (!existsSync(busyFile)) return false;
      sawBusy = true;
      return Date.now() - statSync(busyFile).mtimeMs < 6_000;
    } catch {
      return false;
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    let fallbackDelay = 100;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      resolve(result);
    };

    const scheduleFallback = () => {
      if (!settled) {
        timer = setTimeout(check, fallbackDelay);
        fallbackDelay = POLL_FALLBACK_MS;
      }
    };

    const check = () => {
      if (settled) return;
      if (existsSync(resFile)) {
        try {
          const raw = readFileSync(resFile, "utf-8");
          const result = JSON.parse(raw) as CommandResult;
          if (typeof result !== "object" || result === null || typeof result.success !== "boolean") {
            lastResponseParseError = "Failed to parse response: missing boolean success field";
          } else {
            finish(result);
            return;
          }
        } catch (e) {
          // A CEP response can be observed while an older connector is still writing it.
          // Keep polling the same response file; never resend the host operation.
          lastResponseParseError =
            `Failed to parse response: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        const stillBusy = busyIsFresh();
        if (stillBusy && elapsed <= hardCapMs) {
          scheduleFallback();
          return;
        }
        if (lastResponseParseError) {
          finish({ success: false, error: lastResponseParseError });
          return;
        }
        finish({
          success: false,
          error: sawBusy
            ? `Premiere accepted the script but did not finish within ${elapsed}ms. ` +
              `A modal dialog inside Premiere Pro is likely blocking the scripting engine — ` +
              `check the Premiere window and dismiss any open dialog. ` +
              `(The result, if any, will be discarded.)`
            : `Command timed out after ${timeoutMs}ms. Is the CEP plugin running in Premiere Pro?`,
        });
        return;
      }

      scheduleFallback();
    };

    // Prefer event-driven notification for low response latency without constant stat calls.
    // fs.watch is not reliable on every network/virtual filesystem, so the slower timer above
    // remains the correctness fallback and also protects against missed/coalesced events.
    try {
      const responseName = basename(resFile);
      watcher = watch(dirname(resFile), { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === responseName) check();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }

    check();
  });
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up any stale command/response files from the temp directory.
 */
export function cleanupTempDir(options?: BridgeOptions): void {
  const tempDir = getTempDir(options);
  if (!existsSync(tempDir)) return;

  try {
    const files = readdirSync(tempDir);
    const ownerStates = inspectOwnerStates(tempDir, files, getBridgeOwnerId(options));
    const freshBusyIds = new Set<string>();
    for (const file of files) {
      const protocolFile = parseProtocolFile(file);
      if (protocolFile?.kind === "busy" && !isStaleProtocolFile(join(tempDir, file))) {
        freshBusyIds.add(protocolFile.id);
      }
    }
    for (const file of files) {
      const protocolFile = parseProtocolFile(file);
      if (!protocolFile) continue;
      const ownerId = protocolOwnerId(protocolFile.id);
      const ownedByLiveBridge = ownerId ? ownerStates.active.has(ownerId) : false;
      if (ownedByLiveBridge) continue;
      // Remove namespaced files immediately only after a well-formed lease
      // proves their owner is dead; unknown lease state stays age-protected.
      if (ownerId && ownerStates.dead.has(ownerId)) {
        safeUnlink(join(tempDir, file));
        continue;
      }
      if (freshBusyIds.has(protocolFile.id)) continue;
      if (isStaleProtocolFile(join(tempDir, file))) safeUnlink(join(tempDir, file));
    }
  } catch {
    // Ignore cleanup errors
  }
}

function getBridgeOwnerId(options?: BridgeOptions): string {
  if (!options) return processOwnerId;
  const existing = bridgeOwnerIds.get(options);
  if (existing) return existing;
  const ownerId = randomUUID();
  bridgeOwnerIds.set(options, ownerId);
  return ownerId;
}

function ownerLeasePath(tempDir: string, ownerId: string): string {
  return join(tempDir, `${OWNER_LEASE_PREFIX}${ownerId}.json`);
}

function ensureOwnerLease(tempDir: string, ownerId: string): void {
  const leasePath = ownerLeasePath(tempDir, ownerId);
  if (existsSync(leasePath)) return;
  const stagedPath = `${leasePath}.staged`;
  try {
    writeFileSync(stagedPath, JSON.stringify({
      protocolVersion: OWNER_LEASE_VERSION,
      ownerId,
      pid: process.pid,
    }), "utf-8");
    renameSync(stagedPath, leasePath);
  } finally {
    safeUnlink(stagedPath);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function inspectOwnerStates(tempDir: string, files: string[], currentOwnerId: string): OwnerStates {
  const active = new Set<string>([currentOwnerId]);
  const dead = new Set<string>();
  for (const file of files) {
    const match = new RegExp(`^${OWNER_LEASE_PREFIX}([0-9a-f-]{36})\\.json$`, "i").exec(file);
    if (!match) continue;
    const leasePath = join(tempDir, file);
    try {
      const lease = JSON.parse(readFileSync(leasePath, "utf-8")) as Record<string, unknown>;
      const pid = lease.pid;
      const ownerId = match[1];
      if (
        lease.protocolVersion === OWNER_LEASE_VERSION
        && (lease.ownerId === undefined || lease.ownerId === ownerId)
        && typeof pid === "number"
        && Number.isSafeInteger(pid)
        && pid > 0
        && isProcessAlive(pid)
      ) {
        active.add(ownerId);
      } else if (
        lease.protocolVersion === OWNER_LEASE_VERSION
        && (lease.ownerId === undefined || lease.ownerId === ownerId)
        && typeof pid === "number"
        && Number.isSafeInteger(pid)
        && pid > 0
      ) {
        dead.add(ownerId);
        safeUnlink(leasePath);
      } else {
        // Keep malformed leases and their protocol files age-protected.
      }
    } catch {
      // Preserve malformed lease files; protocol files remain age-protected.
    }
  }
  return { active, dead };
}

function protocolOwnerId(id: string): string | null {
  const separator = id.indexOf("_");
  if (separator < 0) return null;
  const ownerId = id.slice(0, separator);
  return OWNER_ID_PATTERN.test(ownerId) ? ownerId : null;
}

function parseProtocolFile(file: string): { kind: "cmd" | "res" | "busy"; id: string } | null {
  const match = /^(cmd_|res_|busy_)(.+?)(?:\.jsx(?:\.staged)?|\.json)$/.exec(file);
  if (!match) return null;
  return {
    kind: match[1].slice(0, -1) as "cmd" | "res" | "busy",
    id: match[2],
  };
}

function isStaleProtocolFile(filePath: string): boolean {
  try {
    const modifiedAt = statSync(filePath).mtimeMs;
    return Number.isFinite(modifiedAt) && Date.now() - modifiedAt > STALE_PROTOCOL_FILE_MS;
  } catch {
    return false;
  }
}
