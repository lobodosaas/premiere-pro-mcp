(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpCommandDiagnostics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PHASES = new Set([
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
    "failed"
  ]);

  function createCommandDiagnostics(options) {
    const requested = Number(options && options.capacity);
    const capacity = Number.isInteger(requested)
      ? Math.min(256, Math.max(1, requested))
      : 64;
    const records = [];
    let sequence = 0;
    let dropped = 0;

    return {
      record(command, requestId, phase) {
        if (!PHASES.has(phase)) throw new Error("Unsupported diagnostic phase");
        records.push({
          sequence: ++sequence,
          command: String(command || "unknown").slice(0, 128),
          requestIdPresent: typeof requestId === "string" && requestId.length > 0,
          phase
        });
        while (records.length > capacity) {
          records.shift();
          dropped += 1;
        }
      },
      snapshot() {
        return { records: records.map((record) => ({ ...record })), capacity, dropped };
      },
      clear() {
        records.splice(0);
        dropped = 0;
      }
    };
  }

  return { createCommandDiagnostics };
});
