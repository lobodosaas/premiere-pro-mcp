import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const protocol = require("../../uxp-plugin/protocol.cjs");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function panelCapabilities() {
  return { commands: { "capabilities.get": {}, "state.get": {}, "frame.export": {} } };
}

function createPanelRuntimeHarness(options: { exporterResult?: boolean; workspaceFiles?: string[]; fakeClockStepMs?: number; stateGate?: Promise<void> } = {}) {
  const panelSource = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
  const elements: Record<string, any> = {};
  const clickHandlers: Record<string, () => unknown> = {};
  const sockets: any[] = [];
  const capabilityWaiters: Array<{ promise: Promise<any>; resolve: (value: any) => void }> = [];
  const statusValues: string[] = [];
  const diagnosticPhases: string[] = [];
  let diagnosticClearCount = 0;
  let domReady: (() => Promise<void>) | null = null;
  let panelDefinition: any = null;
  let scheduledTimeouts = 0;

  const statusElement: any = {};
  let statusText = "";
  Object.defineProperty(statusElement, "textContent", {
    get: () => statusText,
    set: (value) => { statusText = String(value); statusValues.push(statusText); },
  });
  elements.status = statusElement;
  elements["workspace-status"] = { textContent: "" };
  elements["bridge-url"] = { value: "ws://127.0.0.1:7777/uxp" };
  elements["bridge-token"] = { value: "" };
  ["connect", "refresh", "choose-workspace", "revoke-workspace"].forEach((id) => {
    elements[id] = { addEventListener: (event: string, handler: () => unknown) => {
      if (event === "click") clickHandlers[id] = handler;
    } };
  });

  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    onopen: (() => unknown) | null = null;
    onmessage: ((event: { data: string }) => unknown) | null = null;
    onerror: (() => unknown) | null = null;
    onclose: (() => unknown) | null = null;
    constructor(public url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }
  }

  let workspaceConfigured = false;
  const workspaceBroker = {
    initialize: async () => undefined,
    requestRoot: async () => { workspaceConfigured = true; return workspaceBroker.status(); },
    revoke: async () => { workspaceConfigured = false; return workspaceBroker.status(); },
    assertPathAllowed: async (value: string) => value,
    status: () => ({ configured: workspaceConfigured, rootName: workspaceConfigured ? "Approved" : null, persistent: workspaceConfigured, canonicalPathValidation: "unavailable" }),
  };
  const commandRegistry = {
    initialize: async () => undefined,
    dispose: async () => undefined,
    capabilities: () => {
      const next = deferred<any>();
      capabilityWaiters.push(next);
      return next.promise;
    },
  };
  const project = { getActiveSequence: async () => { if (options.stateGate) await options.stateGate; return sequence; } };
  const sequence = {
    getPlayerPosition: async () => ({ seconds: 1 }),
    getFrameSize: async () => ({ width: 1920, height: 1080 }),
  };
  const exporterCalls: Array<{ position: unknown; filename: string; filepath: string }> = [];
  const exportSequenceFrame = async (_sequence: unknown, position: unknown, filename: string, filepath: string) => {
    exporterCalls.push({ position, filename, filepath });
    return options.exporterResult === undefined ? true : options.exporterResult;
  };
  const toFileUrl = (value: string) => "file://" + value.split("/").map(encodeURIComponent).join("/");
  const workspaceFiles = new Set((options.workspaceFiles ?? []).map(toFileUrl));
  const ppro = {
    Project: { getActiveProject: async () => project },
    Constants: {},
    Exporter: { exportSequenceFrame },
  };
  let fakeClock = 1_700_000_000_000;
  class HarnessDate extends Date {
    static now() {
      if (options.fakeClockStepMs) fakeClock += options.fakeClockStepMs;
      return fakeClock;
    }
  }
  const eventJournal = { status: () => ({}), close: () => undefined, recordHostEvent: () => null };
  const documentStub = {
    addEventListener: (event: string, handler: () => Promise<void>) => {
      if (event === "DOMContentLoaded") domReady = handler;
    },
    getElementById: (id: string) => elements[id],
  };
  const entrypoints = { setup: (definition: any) => { panelDefinition = definition; } };
  const uxp = {
    entrypoints,
    host: { version: "25.0.0" },
    storage: {
      localFileSystem: {
        getEntryWithUrl: async (url: string) => {
          if (workspaceFiles.has(url)) return { url };
          throw new Error("entry not found: " + url);
        },
      },
    },
  };
  const commandDiagnostics = {
    createCommandDiagnostics: () => ({
      record: (_command: string, _requestId: string | null, phase: string) => { diagnosticPhases.push(phase); },
      snapshot: () => ({ phases: diagnosticPhases.slice() }),
      clear: () => { diagnosticClearCount += 1; diagnosticPhases.length = 0; },
    }),
  };
  const context: Record<string, any> = {
    document: documentStub,
    WebSocket: FakeWebSocket,
    URL,
    Date: options.fakeClockStepMs ? HarnessDate : Date,
    setTimeout: (fn: () => void) => { scheduledTimeouts += 1; queueMicrotask(fn); return scheduledTimeouts; },
    queueMicrotask,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    PremiereMcpProtocol: protocol,
    PremiereMcpTranscript: { versionAtLeast: () => false },
    PremiereMcpWorkspace: {
      createWorkspaceBroker: () => workspaceBroker,
      validateLoopbackBridgeUrl: (value: string) => new URL(value),
    },
    PremiereMcpEvents: { createEventJournal: () => eventJournal },
    PremiereMcpCommands: { createCommandRegistry: () => commandRegistry },
    PremiereMcpCommandDiagnostics: commandDiagnostics,
    require: (name: string) => name === "uxp" ? uxp : name === "premierepro" ? ppro : undefined,
    console,
  };
  runInNewContext(panelSource, context, { filename: "uxp-plugin/index.cjs" });

  return {
    async start() {
      if (!domReady) throw new Error("DOMContentLoaded handler was not registered");
      await domReady();
    },
    sockets,
    capabilityWaiters,
    clickHandlers,
    statusValues,
    diagnosticPhases,
    exporterCalls,
    get diagnosticClearCount() { return diagnosticClearCount; },
    get scheduledTimeouts() { return scheduledTimeouts; },
    panelDefinition,
  };
}

async function dispatchExport(
  harness: ReturnType<typeof createPanelRuntimeHarness>,
  args: Record<string, unknown>,
) {
  const socket = harness.sockets[0];
  if (!socket.onmessage) throw new Error("socket did not register onmessage");
  socket.onmessage({ data: JSON.stringify({ type: "command", requestId: "fx1", command: "frame.export", args }) });
  const isResult = (raw: string) => {
    try { const value = JSON.parse(raw); return value.type === "result" && value.requestId === "fx1"; } catch { return false; }
  };
  await vi.waitFor(() => {
    if (!socket.sent.some(isResult)) throw new Error("no frame.export result yet");
  }, { timeout: 10_000 });
  const raw = socket.sent.find(isResult);
  if (!raw) throw new Error("response vanished");
  return JSON.parse(raw);
}

describe("UXP bridge protocol", () => {
  it("builds versioned envelopes", () => {
    const result = protocol.envelope("event", { name: "changed" }, "r1");
    expect(result).toMatchObject({ protocolVersion: 2, type: "event", requestId: "r1", payload: { name: "changed" } });
    expect(Date.parse(result.sentAt)).not.toBeNaN();
  });
  it("parses commands with safe defaults", () => {
    expect(protocol.parseCommand('{"type":"command","command":"state.get"}')).toEqual({ requestId: null, command: "state.get", args: {} });
  });
  it.each([
    "projectSelection.views",
    "bins.createSmart",
    "sequenceSettings.update",
    "parameters.keyframeAdd",
    "timeline.cloneSelection",
    "sequences.createFromMedia",
    "encoder.projectItem",
  ])("accepts registered lower-camel command segments: %s", (command) => {
    expect(protocol.parseCommand({ type: "command", command })).toMatchObject({ command });
  });
  it("rejects malformed commands", () => expect(() => protocol.parseCommand({ type: "event" })).toThrow("Invalid UXP bridge command"));
  it("rejects invalid protocol versions and argument shapes", () => {
    expect(() => protocol.parseCommand({ protocolVersion: 1, type: "command", command: "state.get" })).toThrow("Unsupported UXP protocol version");
    expect(() => protocol.parseCommand({ type: "command", command: "state.get", args: [] })).toThrow("args must be an object");
    expect(() => protocol.parseCommand({ type: "command", command: "../state" })).toThrow("Invalid UXP bridge command");
    expect(() => protocol.parseCommand({ type: "command", command: "ProjectSelection.views" })).toThrow("Invalid UXP bridge command");
    expect(() => protocol.parseCommand({ type: "command", command: "project_selection.views" })).toThrow("Invalid UXP bridge command");
  });
  it("bounds request identifiers and command size", () => {
    expect(() => protocol.parseCommand({ type: "command", requestId: "", command: "state.get" })).toThrow("requestId");
    const oversized = JSON.stringify({ type: "command", command: "state.get", padding: "x".repeat(protocol.MAX_COMMAND_BYTES) });
    expect(() => protocol.parseCommand(oversized)).toThrow("64 KiB");
  });
  it("bounds complete result envelopes by UTF-8 bytes", () => {
    expect(protocol.utf8ByteLength("aé😀")).toBe(7);
    expect(() => protocol.assertResultSize({
      projectMetadata: "😀".repeat(170_000),
      xmpMetadata: "😀".repeat(170_000),
    })).toThrow("1 MiB");
    expect(protocol.serializeEnvelope(protocol.envelope("result", { ok: true, result: { value: "small" } }, "r1")))
      .toContain('"type":"result"');
  });
  it("pre-serializes a success result before publishing its completed event", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    const dispatchStart = panel.indexOf("async function dispatch(raw)");
    const validation = panel.indexOf("Protocol.serializeEnvelope(response);", dispatchStart);
    const completion = panel.indexOf('publishOperation("completed"', dispatchStart);
    expect(validation).toBeGreaterThan(dispatchStart);
    expect(completion).toBeGreaterThan(validation);
  });
  it("emits sanitized command phases around state host reads", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    expect(panel).toContain("PremiereMcpCommandDiagnostics");
    expect(panel).toMatch(/traceCommand\(cmd\.command, cmd\.requestId, "parsed"/);
    expect(panel).toMatch(/traceCommand\("state\.get", requestId, "host\.playhead\.started"/);
    expect(panel).toContain('name: "premiere.bridge.command.trace"');
    expect(panel).not.toMatch(/traceCommand\([^\n]*(args|result|token|path)/);
  });
  it("clears panel diagnostics at reconnect and disconnect boundaries", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    const connectStart = panel.indexOf("function connect()");
    const newSocket = panel.indexOf("new WebSocket(url)", connectStart);
    const closeHandler = panel.indexOf("socket.onclose = () =>", connectStart);
    const disconnectStart = panel.indexOf("function disconnect()");
    const connectClear = panel.indexOf("commandDiagnostics.clear();", connectStart);
    const closeClear = panel.indexOf("commandDiagnostics.clear();", closeHandler);
    const disconnectClear = panel.indexOf("commandDiagnostics.clear();", disconnectStart);
    expect(connectClear).toBeGreaterThan(connectStart);
    expect(connectClear).toBeLessThan(newSocket);
    expect(closeClear).toBeGreaterThan(closeHandler);
    expect(disconnectClear).toBeGreaterThan(disconnectStart);
  });
  it("routes transcript imports through the replay-aware command registry", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    expect(panel).toContain("transcriptImportHandler: importTranscript");
    expect(panel).not.toContain('cmd.command === "transcript.import") result = await importTranscript');
  });
  it("prevents filename path traversal", () => {
    expect(protocol.safeFilename("shot-01.png")).toBe("shot-01.png");
    expect(() => protocol.safeFilename("../shot.png")).toThrow();
    expect(() => protocol.safeFilename("shot.jpg")).toThrow();
  });
  it("joins Windows and POSIX-style output paths", () => {
    expect(protocol.joinPath("C:/temp", "a.png")).toBe("C:/temp/a.png");
    expect(protocol.joinPath("C:/temp/", "a.png")).toBe("C:/temp/a.png");
  });
  it("passes Adobe's required full filename and trailing directory separator through the panel", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    expect(panel).toContain("const path = Protocol.joinPath(outputDirectory, filename);");
    expect(panel).toContain("exportSequenceFrame(sequence, position, path, exporterDirectory, width, height)");
  });
  it("validates direct panel frame exports against the exact approved workspace root", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    const exportStart = panel.indexOf("async function exportFrame(args, operation");
    const validation = panel.indexOf(
      'workspaceBroker.assertPathAllowed(args.outputDirectory, { label: "outputDirectory", kind: "directory", rootOnly: true })',
      exportStart,
    );
    expect(exportStart).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(exportStart);
  });
  it("accepts a frame export whose file lands despite a false exporter result", async () => {
    const dir = "C:/Users/gusta/AppData/Local/Temp/opencode";
    const harness = createPanelRuntimeHarness({ exporterResult: false, workspaceFiles: [dir + "/proof.png"] });
    await harness.start();
    const response = await dispatchExport(harness, { outputDirectory: dir, filename: "proof.png" });
    expect(response.payload).toMatchObject({ ok: true });
    expect(response.payload.result).toMatchObject({
      path: dir + "/proof.png", exporterResult: false, verifiedOnDisk: true,
    });
    expect(harness.exporterCalls).toEqual([{
      position: { seconds: 1 },
      filename: dir + "/proof.png",
      filepath: dir + "/",
    }]);
  });
  it("reports both failure signals when the exporter returns false and no file appears", async () => {
    const harness = createPanelRuntimeHarness({ exporterResult: false, fakeClockStepMs: 30_000 });
    await harness.start();
    const response = await dispatchExport(harness, {
      outputDirectory: "C:/Users/gusta/AppData/Local/Temp/opencode", filename: "missing.png",
    });
    expect(response.payload.ok).toBe(false);
    const message = typeof response.payload.error === "string"
      ? response.payload.error
      : String(response.payload.error?.message ?? "");
    expect(message).toMatch(/no file appeared/i);
  });
  it("recovers the real filename when the host appends a second extension", async () => {
    const dir = "C:/Users/gusta/AppData/Local/Temp/opencode";
    const harness = createPanelRuntimeHarness({ exporterResult: false, workspaceFiles: [dir + "/doubled.png.png"] });
    await harness.start();
    const response = await dispatchExport(harness, { outputDirectory: dir, filename: "doubled.png" });
    expect(response.payload.result).toMatchObject({
      path: dir + "/doubled.png.png", exporterResult: false, verifiedOnDisk: true,
    });
  });
  it("reconnects after successful workspace changes but not picker cancellation or failure", () => {
    const panel = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    const chooseStart = panel.indexOf("async function chooseWorkspace()");
    const chooseRequest = panel.indexOf("await workspaceBroker.requestRoot();", chooseStart);
    const chooseConnect = panel.indexOf("connect();", chooseRequest);
    const chooseCatch = panel.indexOf("} catch (error)", chooseStart);
    const revokeStart = panel.indexOf("async function revokeWorkspace()");
    const revokeRequest = panel.indexOf("await workspaceBroker.revoke();", revokeStart);
    const revokeConnect = panel.indexOf("connect();", revokeRequest);
    const revokeCatch = panel.indexOf("} catch (error)", revokeStart);

    expect(chooseConnect).toBeGreaterThan(chooseRequest);
    expect(chooseConnect).toBeLessThan(chooseCatch);
    expect(revokeConnect).toBeGreaterThan(revokeRequest);
    expect(revokeConnect).toBeLessThan(revokeCatch);
  });
  it("blocks a superseded async onopen callback from publishing to replacement connection", async () => {
    const harness = createPanelRuntimeHarness();
    await harness.start();
    const oldSocket = harness.sockets[0];
    if (!oldSocket.onopen) throw new Error("Initial socket did not register onopen");
    const oldOpen = oldSocket.onopen();
    expect(harness.capabilityWaiters).toHaveLength(1);

    await harness.clickHandlers["choose-workspace"]();
    const replacementSocket = harness.sockets[1];
    if (!replacementSocket.onopen) throw new Error("Replacement socket did not register onopen");
    const replacementOpen = replacementSocket.onopen();
    expect(harness.capabilityWaiters).toHaveLength(2);
    const statusCount = harness.statusValues.length;
    const diagnostics = harness.diagnosticPhases.slice();

    harness.capabilityWaiters[0].resolve(panelCapabilities());
    await oldOpen;

    expect(replacementSocket.sent).toHaveLength(0);
    expect(harness.statusValues.slice(statusCount)).toEqual([]);
    expect(harness.diagnosticPhases).toEqual(diagnostics);
    expect(harness.scheduledTimeouts).toBe(0);

    harness.capabilityWaiters[1].resolve(panelCapabilities());
    await replacementOpen;
    expect(JSON.parse(replacementSocket.sent[0])).toMatchObject({ type: "hello" });
    expect(harness.diagnosticPhases.length).toBeGreaterThan(0);
  });
  it("detaches superseded handlers and invalidates pending callbacks on disconnect", async () => {
    const harness = createPanelRuntimeHarness();
    await harness.start();
    const oldSocket = harness.sockets[0];
    if (!oldSocket.onopen) throw new Error("Initial socket did not register onopen");
    const oldOpen = oldSocket.onopen();
    expect(harness.capabilityWaiters).toHaveLength(1);

    await harness.clickHandlers["choose-workspace"]();
    expect([oldSocket.onopen, oldSocket.onmessage, oldSocket.onerror, oldSocket.onclose])
      .toEqual([null, null, null, null]);

    harness.panelDefinition.panels.mcpBridgePanel.destroy();
    harness.capabilityWaiters[0].resolve(panelCapabilities());
    await oldOpen;
    expect(harness.diagnosticPhases).toEqual([]);
  });

  it("routes an in-flight command response to its originating connection", async () => {
    const state = deferred<void>();
    const harness = createPanelRuntimeHarness({ stateGate: state.promise });
    await harness.start();
    const oldSocket = harness.sockets[0];
    if (!oldSocket.onmessage) throw new Error("Initial socket did not register onmessage");

    oldSocket.onmessage({ data: JSON.stringify({
      type: "command",
      requestId: "old-state",
      command: "state.get",
      args: {},
    }) });
    await Promise.resolve();

    await harness.clickHandlers["choose-workspace"]();
    const replacementSocket = harness.sockets[1];
    state.resolve();

    const isResult = (raw: string) => {
      try {
        const value = JSON.parse(raw);
        return value.type === "result" && value.requestId === "old-state";
      } catch (_) {
        return false;
      }
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(oldSocket.sent.some(isResult)).toBe(false);
    expect(replacementSocket.sent.some(isResult)).toBe(false);
  });

  it("describes verification, undo, transaction, and cancellation boundaries", () => {
    expect(protocol.operationSemantics({
      mutatesProject: true,
      verificationStatus: "verified",
      verificationBoundary: "post_action_snapshot",
      verificationEvidence: [{ type: "sequence", id: "s1" }],
      undoSupported: true,
      undoLabel: "Rename track",
      transactionActionGroup: true,
      cancellationSupported: false,
    })).toEqual({
      mutatesProject: true,
      verification: {
        status: "verified",
        boundary: "post_action_snapshot",
        evidence: [{ type: "sequence", id: "s1" }],
      },
      undo: {
        supported: true,
        boundary: "premiere_undo_history",
        label: "Rename track",
      },
      transaction: {
        actionGroup: true,
        boundary: "project_executeTransaction",
        atomicRollback: false,
      },
      cancellation: {
        supported: false,
        boundary: "before_non_cancellable_host_call",
      },
    });
  });

  it("emits correlated operation lifecycle events", () => {
    expect(protocol.operationEvent(
      "progress",
      { requestId: "op-1", command: "frame.export" },
      { phase: "verification", progress: 0.8 },
    )).toMatchObject({
      protocolVersion: 2,
      type: "event",
      requestId: "op-1",
      payload: {
        name: "premiere.operation.progress",
        operation: {
          requestId: "op-1",
          command: "frame.export",
          phase: "verification",
          progress: 0.8,
        },
      },
    });
  });

  it("only accepts cancellation before a non-cancellable host call", () => {
    const tracker = protocol.createOperationTracker();
    const operation = tracker.begin("op-1", "frame.export");
    expect(tracker.requestCancel("op-1")).toEqual({
      accepted: true,
      reason: "cancellation_requested",
    });
    tracker.finish(operation);
    expect(tracker.requestCancel("op-1")).toEqual({
      accepted: false,
      reason: "operation_not_active",
    });

    const inHost = tracker.begin("op-2", "frame.export");
    inHost.phase = "host_call";
    expect(tracker.requestCancel("op-2")).toEqual({
      accepted: false,
      reason: "host_call_not_cancellable",
    });
  });
});
