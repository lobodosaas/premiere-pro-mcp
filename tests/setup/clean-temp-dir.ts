import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test bridge directory base.
 *
 * The bridge enforces a Windows ACL policy: the directory must be owned by the
 * current user and neither it nor its ancestors may grant write or replace
 * rights to untrusted identities. A machine-wide temp root can carry such
 * grants (for example an inherited ACE for a sandbox group), which is correct
 * to refuse but makes `os.tmpdir()` unusable for these tests. Tests therefore
 * use a base directory whose ancestors stay inside the user profile on Windows
 * and keep the OS temp directory elsewhere.
 */
export function testTempBase(): string {
  const base = process.platform === "win32"
    ? join(homedir(), ".premiere-mcp-test-bridge")
    : join(tmpdir(), "premiere-mcp-test-bridge");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

// The product resolves its bridge directory from PREMIERE_TEMP_DIR before the
// platform default, so point every test process at the same clean base.
process.env.PREMIERE_TEMP_DIR = testTempBase();
