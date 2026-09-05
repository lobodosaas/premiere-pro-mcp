#!/usr/bin/env node
// Writes dist/build-info.json so a running broker can later prove which
// build it actually loaded. Usage: node scripts/write-build-info.mjs [--out <dir>]
// Never prints secrets; only commit/package/timestamp metadata plus sha256
// hashes of the shipped server entrypoint and panel workflow bundle.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const HASHED_ARTIFACTS = ["dist/index.js", "uxp-plugin/advanced-workflows.cjs"];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function gitCommit(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function sha256File(absolute) {
  return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

const outDir = path.resolve(argValue("--out") ?? path.join(repoRoot, "dist"));
const packageVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version ?? "unknown";
const files = {};
for (const relative of HASHED_ARTIFACTS) {
  const absolute = path.join(repoRoot, relative);
  if (existsSync(absolute)) files[relative] = sha256File(absolute);
}

mkdirSync(outDir, { recursive: true });
const record = {
  schemaVersion: 1,
  commit: gitCommit(repoRoot),
  packageVersion: String(packageVersion),
  builtAt: new Date().toISOString(),
  files,
};
writeFileSync(path.join(outDir, "build-info.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(`build-info written: commit=${record.commit} version=${record.packageVersion}`);
