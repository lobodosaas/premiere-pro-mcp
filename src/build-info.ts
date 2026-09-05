import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerBuildInfo {
  /** False when no trustworthy build record was found; never throws. */
  found: boolean;
  commit: string | null;
  packageVersion: string | null;
  builtAt: string | null;
  /** Where the record came from: file path, "injected", or "missing". */
  source: string;
  /** ISO timestamp of when the running process captured this record. */
  capturedAt?: string;
}

const BUILD_INFO_FILENAME = "build-info.json";

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read the build record written by `scripts/write-build-info.mjs` during
 * `npm run build`. Never throws: a missing, unreadable, or malformed file
 * yields `{ found: false, ... }` so diagnostics degrade gracefully.
 *
 * `distDir` defaults to the compiled module's own directory (`dist/`).
 * Tests pass an explicit directory. This intentionally does NOT re-read the
 * file on every call site: capture once at broker/server startup and reuse
 * the snapshot, otherwise a rebuilt `dist/` could be misreported as loaded.
 */
export function readServerBuildInfo(distDir?: string): ServerBuildInfo {
  const directory = distDir ?? dirname(fileURLToPath(import.meta.url));
  const file = join(directory, BUILD_INFO_FILENAME);
  if (!existsSync(file)) {
    return { found: false, commit: null, packageVersion: null, builtAt: null, source: "missing" };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    const record = raw as Record<string, unknown>;
    const commit = asNonEmptyString(record.commit);
    const packageVersion = asNonEmptyString(record.packageVersion);
    const builtAt = asNonEmptyString(record.builtAt);
    if (!commit || !packageVersion || !builtAt) throw new Error("incomplete record");
    return { found: true, commit, packageVersion, builtAt, source: file };
  } catch {
    return { found: false, commit: null, packageVersion: null, builtAt: null, source: file };
  }
}
