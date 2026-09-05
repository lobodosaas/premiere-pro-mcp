import { describe, it, expect, vi, beforeEach } from "vitest";
import { getKeyframeTools } from "../../src/tools/keyframes.js";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/test-bridge", timeoutMs: 5000 };
const keyframes = getKeyframeTools(bridgeOptions);

const TICKS_PER_SECOND = 254016000000;
const toTicks = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND);

class SimTime {
  ticks: string = "0";
}

type SimKey = { ticks: string };
type SimPropOptions = {
  displayName?: string;
  varying?: boolean;
  supported?: boolean;
  seed?: Array<{ seconds: number; value: unknown }>;
  failSetValueAtKey?: "before-write" | "after-write";
  storeAddKey?: boolean;
};

function simProp(displayName: string, options: SimPropOptions = []) {
  const store = new Map<string, unknown>();
  let varying = options.varying ?? false;
  let failMode = options.failSetValueAtKey ?? null;
  for (const entry of options.seed ?? []) store.set(String(toTicks(entry.seconds)), entry.value);
  return {
    displayName,
    areKeyframesSupported: () => options.supported ?? true,
    isTimeVarying: () => varying,
    setTimeVarying: (value: boolean) => { varying = value; },
    addKey: (time: SimKey) => {
      if (options.storeAddKey === false) return;
      const key = String(time.ticks);
      if (!store.has(key)) store.set(key, undefined);
    },
    getKeys: () => [...store.keys()].map((ticks) => ({ ticks })),
    setValueAtKey: (time: SimKey, value: unknown) => {
      if (failMode === "before-write") { failMode = null; throw new Error("host rejected write"); }
      store.set(String(time.ticks), Array.isArray(value) ? [...value] : value);
      if (failMode === "after-write") { failMode = null; throw new Error("host failed after partial write"); }
    },
    getValueAtKey: (time: SimKey) => {
      const key = String(time.ticks);
      if (!store.has(key)) throw new Error("no such key");
      const value = store.get(key);
      if (value === undefined) throw new Error("key has no value");
      return value;
    },
    getValue: () => 100,
    setValue: () => undefined,
    removeKey: (time: SimKey) => { store.delete(String(time.ticks)); },
    removeKeyRange: () => undefined,
    setInterpolationTypeAtKey: () => undefined,
    getValueAtTime: (time: SimKey) => {
      const key = String(time.ticks);
      if (!store.has(key)) throw new Error("no key at time");
      return store.get(key);
    },
    __store: store,
  };
}

function simComponent(displayName: string, matchName: string, props: Array<ReturnType<typeof simProp>>) {
  const list = Object.assign([...props], { numItems: props.length });
  return { displayName, matchName, properties: list };
}

function simClip(inPointSeconds: number, durationSeconds: number, components: Array<ReturnType<typeof simComponent>>) {
  const list = Object.assign([...components], { numItems: components.length });
  return {
    clip: {
      inPoint: { ticks: String(toTicks(inPointSeconds)) },
      duration: { ticks: String(toTicks(durationSeconds)) },
      components: list,
    },
  };
}

/** Executes a generated script against the simulated host and returns the script's own return value. */
function runScript(script: string, clips: Record<string, ReturnType<typeof simClip>>) {
  let outcome: unknown;
  // The captured script is only the tool IIFE body; the real bridge prepends
  // the shared helpers via bootstrap, so the simulator provides the same ones.
  const runner = new Function(
    "Time",
    "__findClip",
    "__ticksToSeconds",
    "__secondsToTicks",
    "__error",
    "__result",
    script,
  ) as (Time: unknown, find: unknown, toSeconds: unknown, toTicks: unknown, err: unknown, res: unknown) => void;
  runner(
    SimTime,
    (nodeId: string) => clips[nodeId] ?? null,
    (ticks: unknown) => parseFloat(String(ticks)) / TICKS_PER_SECOND,
    (seconds: unknown) => Math.round(parseFloat(String(seconds)) * TICKS_PER_SECOND),
    (message: unknown) => { outcome = { __error: String(message) }; return outcome; },
    (data: unknown) => { outcome = data; return data; },
  );
  return outcome;
}

async function runTool(
  tool: { handler: (args: never) => Promise<unknown> },
  args: unknown,
  clips: Record<string, ReturnType<typeof simClip>>,
) {
  mockedSendCommand.mockClear();
  await tool.handler(args as never);
  expect(mockedSendCommand).toHaveBeenCalledTimes(1);
  const script = mockedSendCommand.mock.calls[0][0] as string;
  return runScript(script, clips);
}

function motionClip(inPointSeconds: number, prop: ReturnType<typeof simProp>) {
  return simClip(inPointSeconds, 0.3, [
    simComponent("Opacidade", "AE.ADBE Opacity", [simProp("Opacidade")]),
    simComponent("Movimento", "AE.ADBE Motion", [prop]),
  ]);
}

beforeEach(() => vi.clearAllMocks());

describe("CEP keyframe scripts against a simulated host", () => {
  it("writes a new scalar key at the in-point-resolved time", async () => {
    const prop = simProp("Opacidade");
    const clips = { "g1": motionClip(3600, prop) };

    const result = await runTool(keyframes.add_keyframe, {
      node_id: "g1", effect_name: "Movimento", property_name: "Opacidade", time_seconds: 0, value: 0,
    }, clips) as Record<string, unknown>;

    expect(result).toMatchObject({ added: true, resolvedPropertyTimeSeconds: 3600 });
    expect(prop.__store.get(String(toTicks(3600)))).toBe(0);
  });

  it("writes a new [x, y] key and reads it back element-wise", async () => {
    const prop = simProp("Posição");
    const clips = { "g1": motionClip(3600, prop) };

    const result = await runTool(keyframes.add_keyframe, {
      node_id: "g1", effect_name: "Movimento", property_name: "Posição", time_seconds: 0.15, value: [0.5, 0.555013],
    }, clips) as Record<string, unknown>;

    expect(result).toMatchObject({ added: true });
    expect(prop.__store.get(String(toTicks(3600.15)))).toEqual([0.5, 0.555013]);
  });

  it("restores the previous value of a pre-existing key when the write partially fails", async () => {
    const prop = simProp("Posição", {
      varying: true,
      seed: [{ seconds: 3600.15, value: 42 }],
      failSetValueAtKey: "after-write",
    });
    const clips = { "g1": motionClip(3600, prop) };

    const result = await runTool(keyframes.add_keyframe, {
      node_id: "g1", effect_name: "Movimento", property_name: "Posição", time_seconds: 0.15, value: [0.5, 0.555013],
    }, clips) as Record<string, unknown>;

    expect(result).toMatchObject({ __error: expect.stringContaining("ROLLBACK") });
    expect(prop.__store.get(String(toTicks(3600.15)))).toBe(42);
    expect(prop.__store.size).toBe(1);
  });

  it("removes only its own key when the host never stores it", async () => {
    const prop = simProp("Opacidade", { storeAddKey: false });
    const clips = { "g1": motionClip(3600, prop) };

    const result = await runTool(keyframes.add_keyframe, {
      node_id: "g1", effect_name: "Movimento", property_name: "Opacidade", time_seconds: 0, value: 0,
    }, clips) as Record<string, unknown>;

    expect(result).toMatchObject({ __error: expect.stringContaining("ROLLBACK") });
    expect(prop.__store.size).toBe(0);
  });

  it("reports relative and resolved times from get_keyframes", async () => {
    const prop = simProp("Posição", {
      varying: true,
      seed: [{ seconds: 3600, value: [0.5, 0.555013] }, { seconds: 3600.15, value: [0.5, 0.5] }],
    });
    const clips = { "g1": motionClip(3600, prop) };

    const result = await runTool(keyframes.get_keyframes, {
      node_id: "g1", effect_name: "Movimento", property_name: "Posição",
    }, clips) as { keyframes: Array<{ relativeTimeSeconds: number; resolvedPropertyTimeSeconds: number }> };

    expect(result.keyframes.map((key) => key.relativeTimeSeconds)).toEqual([0, 0.15]);
    expect(result.keyframes.map((key) => key.resolvedPropertyTimeSeconds)).toEqual([3600, 3600.15]);
  });

  it("reports an empty keyframe list for a non-varying property", async () => {
    const prop = simProp("Opacidade");
    const clips = { "g1": motionClip(3600, prop) };

    const result = await runTool(keyframes.get_keyframes, {
      node_id: "g1", effect_name: "Movimento", property_name: "Opacidade",
    }, clips) as Record<string, unknown>;

    expect(result).toMatchObject({ keyframes: [], isTimeVarying: false });
  });
});
