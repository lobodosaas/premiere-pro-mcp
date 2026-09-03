import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Diagnostics = require("../../uxp-plugin/command-diagnostics.cjs");

describe("UXP command diagnostics", () => {
  it("records only bounded command lifecycle metadata", () => {
    const journal = Diagnostics.createCommandDiagnostics({ capacity: 2 });
    journal.record("state.get", "request-1", "received");
    journal.record("state.get", "request-1", "host.playhead.started");
    journal.record("state.get", "request-1", "host.playhead.completed");

    expect(journal.snapshot()).toEqual({
      records: [
        { sequence: 2, command: "state.get", requestIdPresent: true, phase: "host.playhead.started" },
        { sequence: 3, command: "state.get", requestIdPresent: true, phase: "host.playhead.completed" },
      ],
      capacity: 2,
      dropped: 1,
    });
  });

  it("rejects arbitrary phases and never stores request ids or payloads", () => {
    const journal = Diagnostics.createCommandDiagnostics();
    expect(() => journal.record("state.get", "secret-id", "token=secret"))
      .toThrow("Unsupported diagnostic phase");
    expect(JSON.stringify(journal.snapshot())).not.toContain("secret-id");
    expect(JSON.stringify(journal.snapshot())).not.toContain("secret");
  });

  it("clears retained records and dropped count", () => {
    const journal = Diagnostics.createCommandDiagnostics({ capacity: 1 });
    journal.record("state.get", "request-1", "received");
    journal.record("state.get", "request-1", "parsed");

    journal.clear();

    expect(journal.snapshot()).toEqual({ records: [], capacity: 1, dropped: 0 });
  });
});
