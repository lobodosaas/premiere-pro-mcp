import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Commands = require("../../uxp-plugin/commands.cjs");
const Events = require("../../uxp-plugin/events.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");

type MutableItem = {
  id: string;
  name: string;
  isFolder?: boolean;
  isClip?: boolean;
  type?: number;
  parent?: MutableItem | null;
  children?: MutableItem[];
  color?: number;
  getId: ReturnType<typeof vi.fn>;
  getItems?: ReturnType<typeof vi.fn>;
  getParentBin: ReturnType<typeof vi.fn>;
  getColorLabelIndex: ReturnType<typeof vi.fn>;
  createSetNameAction: ReturnType<typeof vi.fn>;
  createSetColorLabelAction: ReturnType<typeof vi.fn>;
  createBinAction?: ReturnType<typeof vi.fn>;
  createSmartBinAction?: ReturnType<typeof vi.fn>;
  createMoveItemAction?: ReturnType<typeof vi.fn>;
  createRemoveItemAction?: ReturnType<typeof vi.fn>;
};

function advancedHost() {
  let nextItem = 1;
  const makeItem = (id: string, name: string, options: Partial<MutableItem> = {}): MutableItem => {
    const item = {
      id, name, color: 0, type: options.isFolder ? 2 : 1, parent: null,
      children: options.isFolder ? [] : undefined,
      ...options,
    } as MutableItem;
    item.getId = vi.fn(async () => item.id);
    item.getItems = options.isFolder ? vi.fn(async () => item.children || []) : undefined;
    item.getParentBin = vi.fn(async () => item.parent);
    item.getColorLabelIndex = vi.fn(async () => item.color);
    item.createSetNameAction = vi.fn((name: string) => ({ apply: () => { item.name = name; } }));
    item.createSetColorLabelAction = vi.fn((color: number) => ({ apply: () => { item.color = color; } }));
    if (options.isFolder) {
      item.createBinAction = vi.fn((name: string) => ({ apply: () => {
        const created = makeItem(`created-bin-${nextItem++}`, name, { isFolder: true, parent: item });
        item.children?.push(created);
      } }));
      item.createSmartBinAction = vi.fn((name: string) => ({ apply: () => {
        const created = makeItem(`smart-bin-${nextItem++}`, name, { isFolder: true, parent: item });
        item.children?.push(created);
      } }));
      item.createMoveItemAction = vi.fn((child: MutableItem, destination: MutableItem) => ({ apply: () => {
        if (child.parent?.children) child.parent.children = child.parent.children.filter((value) => value !== child);
        destination.children?.push(child);
        child.parent = destination;
      } }));
      item.createRemoveItemAction = vi.fn((child: MutableItem) => ({ apply: () => {
        item.children = item.children?.filter((value) => value !== child);
      } }));
    }
    return item;
  };

  const root = makeItem("root", "Root", { isFolder: true });
  const bin = makeItem("bin-1", "Rushes", { isFolder: true, parent: root });
  const clip = makeItem("clip-1", "Interview.mov", { isClip: true, parent: bin });
  root.children?.push(bin);
  bin.children?.push(clip);

  let markerCounter = 2;
  const makeMarker = (guid: string, name: string, startSeconds = 1) => {
    const state = { name, type: "Comment", comments: "", color: 0, start: startSeconds, duration: 0 };
    return {
      guid,
      getName: vi.fn(async () => state.name),
      getType: vi.fn(async () => state.type),
      getComments: vi.fn(async () => state.comments),
      getColorIndex: vi.fn(async () => state.color),
      getStart: vi.fn(async () => ({ seconds: state.start })),
      getDuration: vi.fn(async () => ({ seconds: state.duration })),
      createSetNameAction: vi.fn((value: string) => ({ apply: () => { state.name = value; } })),
      createSetTypeAction: vi.fn((value: string) => ({ apply: () => { state.type = value; } })),
      createSetCommentsAction: vi.fn((value: string) => ({ apply: () => { state.comments = value; } })),
      createSetDurationAction: vi.fn((value: { seconds: number }) => ({ apply: () => { state.duration = value.seconds; } })),
      createSetColorByIndexAction: vi.fn((value: number) => ({ apply: () => { state.color = value; } })),
      state,
    };
  };
  const markerValues = [makeMarker("marker-1", "Beat")];
  const markers = {
    getMarkers: vi.fn(() => markerValues),
    createAddMarkerAction: vi.fn((name: string, type: string, start: { seconds: number }, duration: { seconds: number }, comments: string) => ({ apply: () => {
      const marker = makeMarker(`marker-${markerCounter++}`, name, start.seconds);
      marker.state.type = type;
      marker.state.duration = duration.seconds;
      marker.state.comments = comments;
      markerValues.push(marker);
    } })),
    createMoveMarkerAction: vi.fn((marker: ReturnType<typeof makeMarker>, time: { seconds: number }) => ({ apply: () => { marker.state.start = time.seconds; } })),
    createRemoveMarkerAction: vi.fn((marker: ReturnType<typeof makeMarker>) => ({ apply: () => markerValues.splice(markerValues.indexOf(marker), 1) })),
  };

  const parameterState = { value: 50, varying: false, keyframes: [] as number[], keyframeValues: [] as Array<{ seconds: number; value: unknown }> };
  const parameter = {
    displayName: "Opacity",
    areKeyframesSupported: vi.fn(async () => true),
    isTimeVarying: vi.fn(() => parameterState.varying),
    getKeyframeListAsTickTimes: vi.fn(() => parameterState.keyframes.map((seconds) => ({ seconds }))),
    getStartValue: vi.fn(async () => ({ value: parameterState.value })),
    getValueAtTime: vi.fn(async (time: { seconds: number }) => {
      const match = parameterState.keyframeValues.find((entry) => Math.abs(entry.seconds - time.seconds) < 1e-6);
      return match ? match.value : parameterState.value;
    }),
    createKeyframe: vi.fn((value: number) => ({ value, position: null as { seconds: number } | null })),
    createSetValueAction: vi.fn((keyframe: { value: number }) => ({ apply: () => { parameterState.value = keyframe.value; } })),
    createSetTimeVaryingAction: vi.fn((value: boolean) => ({ apply: () => { parameterState.varying = value; } })),
    createAddKeyframeAction: vi.fn((keyframe: { value: unknown; position: { seconds: number } }) => ({ apply: () => {
      parameterState.keyframes.push(keyframe.position.seconds);
      parameterState.keyframeValues.push({ seconds: keyframe.position.seconds, value: keyframe.value });
    } })),
    createRemoveKeyframeAction: vi.fn((time: { seconds: number }) => ({ apply: () => {
      parameterState.keyframes = parameterState.keyframes.filter((value) => value !== time.seconds);
      parameterState.keyframeValues = parameterState.keyframeValues.filter((entry) => entry.seconds !== time.seconds);
    } })),
    createRemoveKeyframeRangeAction: vi.fn((start: { seconds: number }, end: { seconds: number }) => ({ apply: () => {
      parameterState.keyframes = parameterState.keyframes.filter((value) => value < start.seconds || value > end.seconds);
      parameterState.keyframeValues = parameterState.keyframeValues.filter((entry) => entry.seconds < start.seconds || entry.seconds > end.seconds);
    } })),
    createSetInterpolationAtKeyframeAction: vi.fn(() => ({ apply: () => undefined })),
  };
  const component = {
    getMatchName: vi.fn(async () => "ADBE Opacity"),
    getDisplayName: vi.fn(async () => "Opacity"),
    getParamCount: vi.fn(() => 1),
    getParam: vi.fn(() => parameter),
  };

  const positionState = { keyframes: [] as number[], keyframeValues: [] as Array<{ seconds: number; value: unknown }>, base: { x: 0.5, y: 0.5 } };
  const positionParam = {
    displayName: "Posição",
    areKeyframesSupported: vi.fn(async () => true),
    isTimeVarying: vi.fn(() => positionState.keyframes.length > 0),
    getKeyframeListAsTickTimes: vi.fn(() => positionState.keyframes.map((seconds) => ({ seconds }))),
    getStartValue: vi.fn(async () => ({ value: positionState.keyframeValues[0]?.value ?? positionState.base })),
    getValueAtTime: vi.fn(async (time: { seconds: number }) => {
      const match = positionState.keyframeValues.find((entry) => Math.abs(entry.seconds - time.seconds) < 1e-6);
      return match ? match.value : positionState.base;
    }),
    createKeyframe: vi.fn((value: unknown) => ({ value, position: null as { seconds: number } | null })),
    createSetValueAction: vi.fn(() => ({ apply: () => undefined })),
    createSetTimeVaryingAction: vi.fn(() => ({ apply: () => undefined })),
    createAddKeyframeAction: vi.fn((keyframe: { value: unknown; position: { seconds: number } }) => ({ apply: () => {
      positionState.keyframes.push(keyframe.position.seconds);
      positionState.keyframeValues.push({ seconds: keyframe.position.seconds, value: keyframe.value });
    } })),
    createRemoveKeyframeAction: vi.fn((time: { seconds: number }) => ({ apply: () => {
      positionState.keyframes = positionState.keyframes.filter((value) => value !== time.seconds);
      positionState.keyframeValues = positionState.keyframeValues.filter((entry) => entry.seconds !== time.seconds);
    } })),
    createRemoveKeyframeRangeAction: vi.fn(() => ({ apply: () => undefined })),
    createSetInterpolationAtKeyframeAction: vi.fn(() => ({ apply: () => undefined })),
  };
  const motionComponent = {
    getMatchName: vi.fn(async () => "AE.ADBE Motion"),
    getDisplayName: vi.fn(async () => "Movimento"),
    getParamCount: vi.fn(() => 1),
    getParam: vi.fn(() => positionParam),
  };
  const vectorComponent = {
    getMatchName: vi.fn(async () => "AE.ADBE Graphic Group"),
    getDisplayName: vi.fn(async () => "Movimento do vetor"),
    getParamCount: vi.fn(() => 0),
    getParam: vi.fn(() => { throw new Error("no params"); }),
  };
  const textComponent = {
    getMatchName: vi.fn(async () => "AE.ADBE Text"),
    getDisplayName: vi.fn(async () => "Texto"),
    getParamCount: vi.fn(() => 1),
    getParam: vi.fn(() => ({ displayName: "Texto de origem" })),
  };
  const chainComponents = [component, motionComponent, vectorComponent, textComponent];
  const chain = {
    getComponentCount: vi.fn(() => chainComponents.length),
    getComponentAtIndex: vi.fn((index: number) => chainComponents[index]),
  };

  const trackState = { name: "Interview V", start: 10, end: 20, inPoint: 3600, outPoint: 3610, disabled: false };
  const trackItem = {
    getComponentChain: vi.fn(async () => chain),
    getName: vi.fn(async () => trackState.name),
    getStartTime: vi.fn(async () => ({ seconds: trackState.start })),
    getEndTime: vi.fn(async () => ({ seconds: trackState.end })),
    getInPoint: vi.fn(async () => ({ seconds: trackState.inPoint })),
    getOutPoint: vi.fn(async () => ({ seconds: trackState.outPoint })),
    getDuration: vi.fn(async () => ({ seconds: trackState.end - trackState.start })),
    getSpeed: vi.fn(async () => 1),
    isSpeedReversed: vi.fn(async () => false),
    isAdjustmentLayer: vi.fn(async () => false),
    isDisabled: vi.fn(async () => trackState.disabled),
    createMoveAction: vi.fn((time: { seconds: number }) => ({ apply: () => { trackState.start += time.seconds; trackState.end += time.seconds; } })),
    createSetStartAction: vi.fn((time: { seconds: number }) => ({ apply: () => { trackState.start = time.seconds; } })),
    createSetEndAction: vi.fn((time: { seconds: number }) => ({ apply: () => { trackState.end = time.seconds; } })),
    createSetInPointAction: vi.fn((time: { seconds: number }) => ({ apply: () => { trackState.inPoint = time.seconds; } })),
    createSetOutPointAction: vi.fn((time: { seconds: number }) => ({ apply: () => { trackState.outPoint = time.seconds; } })),
    createSetDisabledAction: vi.fn((value: boolean) => ({ apply: () => { trackState.disabled = value; } })),
    createSetNameAction: vi.fn((value: string) => ({ apply: () => { trackState.name = value; } })),
  };

  const settingsState = {
    maximumBitDepth: false, maxRenderQuality: false, compositeInLinearColor: false,
    audioSampleRate: 48000, videoFrameRate: 23.976, videoFieldType: 0,
    videoPixelAspectRatio: "square", editingMode: "custom", previewFileFormat: "mpeg",
    previewCodec: "i-frame", videoWidth: 1280, videoHeight: 720,
  };
  const settings = {
    getMaximumBitDepth: vi.fn(async () => settingsState.maximumBitDepth),
    getMaxRenderQuality: vi.fn(async () => settingsState.maxRenderQuality),
    getCompositeInLinearColor: vi.fn(async () => settingsState.compositeInLinearColor),
    getAudioChannelCount: vi.fn(async () => 2),
    getAudioChannelType: vi.fn(async () => 1),
    getAudioSampleRate: vi.fn(async () => ({ value: settingsState.audioSampleRate })),
    getVideoFrameRate: vi.fn(() => ({ value: settingsState.videoFrameRate })),
    getVideoFieldType: vi.fn(async () => settingsState.videoFieldType),
    getVideoPixelAspectRatio: vi.fn(async () => settingsState.videoPixelAspectRatio),
    getEditingMode: vi.fn(async () => settingsState.editingMode),
    getPreviewFileFormat: vi.fn(async () => settingsState.previewFileFormat),
    getPreviewCodec: vi.fn(async () => settingsState.previewCodec),
    getVideoFrameRect: vi.fn(async () => ({ width: settingsState.videoWidth, height: settingsState.videoHeight })),
    getPreviewFrameRect: vi.fn(async () => ({ width: 640, height: 360 })),
    setMaximumBitDepth: vi.fn(async (value: boolean) => { settingsState.maximumBitDepth = value; return true; }),
    setMaxRenderQuality: vi.fn(async (value: boolean) => { settingsState.maxRenderQuality = value; return true; }),
    setCompositeInLinearColor: vi.fn(async (value: boolean) => { settingsState.compositeInLinearColor = value; return true; }),
    setAudioSampleRate: vi.fn(async (value: { value: number }) => { settingsState.audioSampleRate = value.value; return true; }),
    setVideoFrameRate: vi.fn((value: { value: number }) => { settingsState.videoFrameRate = value.value; return true; }),
    setVideoFieldType: vi.fn(async (value: number) => { settingsState.videoFieldType = value; return true; }),
    setVideoPixelAspectRatio: vi.fn(async (value: string) => { settingsState.videoPixelAspectRatio = value; return true; }),
    setEditingMode: vi.fn(async (value: string) => { settingsState.editingMode = value; return true; }),
    setPreviewFileFormat: vi.fn(async (value: string) => { settingsState.previewFileFormat = value; return true; }),
    setPreviewCodec: vi.fn(async (value: string) => { settingsState.previewCodec = value; return true; }),
    setVideoFrameRect: vi.fn(async (value: { width: number; height: number }) => { settingsState.videoWidth = value.width; settingsState.videoHeight = value.height; return true; }),
  };

  const selection = { getTrackItems: vi.fn(async () => [trackItem]) };
  const sequence = {
    guid: "sequence-1", name: "Assembly",
    getSelection: vi.fn(async () => selection),
    getVideoTrackCount: vi.fn(async () => 1),
    getVideoTrack: vi.fn(async () => ({ getTrackItems: vi.fn(async () => [trackItem]) })),
    getAudioTrackCount: vi.fn(async () => 1),
    getAudioTrack: vi.fn(async () => ({ getTrackItems: vi.fn(async () => [trackItem]) })),
    getSettings: vi.fn(async () => settings),
    createSetSettingsAction: vi.fn(() => ({ apply: () => undefined })),
    createCloneAction: vi.fn(() => ({ apply: () => sequences.push({ guid: "sequence-2", name: "Assembly Copy" }) })),
    createSubsequence: vi.fn(async () => ({ guid: "sequence-3", name: "Assembly Subsequence" })),
  };
  const sequences: Array<{ guid: string; name: string }> = [sequence];

  const addAction = vi.fn((action: { apply?: () => void }) => { action.apply?.(); return true; });
  const project = {
    guid: "project-1", name: "Documentary",
    getActiveSequence: vi.fn(async () => sequence),
    getSequences: vi.fn(async () => sequences),
    getRootItem: vi.fn(async () => root),
    lockedAccess: vi.fn((callback: () => void) => callback()),
    executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }),
    importFiles: vi.fn(async (paths: string[], _suppress: boolean, target?: MutableItem) => {
      const parent = target || root;
      for (const path of paths) parent.children?.push(makeItem(`import-${nextItem++}`, path.split("/").at(-1) || path, { isClip: true, parent }));
      return true;
    }),
    importSequences: vi.fn(async () => true),
    importAEComps: vi.fn(async () => true),
    importAllAEComps: vi.fn(async () => true),
    createSequenceFromMedia: vi.fn(async (name: string) => ({ guid: "sequence-created", name })),
    setActiveSequence: vi.fn(async () => true),
    openSequence: vi.fn(async () => true),
    closeSequence: vi.fn(async () => true),
    deleteSequence: vi.fn(async (target: { guid: string }) => { const index = sequences.indexOf(target); if (index >= 0) sequences.splice(index, 1); return true; }),
  };

  const editor = {
    createInsertProjectItemAction: vi.fn(() => ({ apply: () => undefined })),
    createOverwriteItemAction: vi.fn(() => ({ apply: () => undefined })),
    createCloneTrackItemAction: vi.fn(() => ({ apply: () => undefined })),
    createRemoveItemsAction: vi.fn(() => ({ apply: () => undefined })),
    insertMogrtFromPath: vi.fn(() => [trackItem]),
    insertMogrtFromLibrary: vi.fn(() => [trackItem]),
  };
  const manager = {
    isAMEInstalled: true,
    exportSequence: vi.fn(async () => true),
    encodeProjectItem: vi.fn(async () => true),
    encodeFile: vi.fn(async () => true),
  };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) },
    ProjectUtils: {
      getSelection: vi.fn(async () => ({ getItems: vi.fn(async () => [clip]) })),
      getProjectViewIds: vi.fn(async () => ["view-1"]),
      getProjectFromViewId: vi.fn(async () => project),
      getSelectionFromViewId: vi.fn(async () => ({ getItems: vi.fn(async () => [clip]) })),
    },
    Markers: { getMarkers: vi.fn(async () => markers) },
    Marker: { MARKER_TYPE_COMMENT: "Comment" },
    FolderItem: { cast: vi.fn((item: MutableItem) => { if (!item.isFolder) throw new Error("not folder"); return item; }) },
    ClipProjectItem: { cast: vi.fn((item: MutableItem) => { if (!item.isClip) throw new Error("not clip"); return item; }) },
    TickTime: { createWithSeconds: vi.fn((seconds: number) => ({ seconds })) },
    PointF: class PointF { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } },
    FrameRate: { createWithValue: vi.fn((value: number) => ({ value })) },
    RectF: class RectF { width = 0; height = 0; },
    Guid: { fromString: vi.fn((value: string) => value) },
    Constants: {
      TrackItemType: { CLIP: 1 }, MediaType: { ANY: 0, VIDEO: 1, AUDIO: 2 },
      InterpolationMode: { LINEAR: 1, HOLD: 2, BEZIER: 3, TIME: 4 },
      ExportType: { QUEUE_TO_AME: "ame", QUEUE_TO_APP: "app", IMMEDIATELY: "now" },
    },
    SequenceEditor: { getEditor: vi.fn(() => editor) },
    EncoderManager: {
      getManager: vi.fn(() => manager),
      getExportFileExtension: vi.fn(async () => "mp4"),
      EXPORT_QUEUE_TO_AME: "ame", EXPORT_QUEUE_TO_APP: "app", EXPORT_IMMEDIATELY: "now",
    },
    Utils: { isAEInstalled: vi.fn(async () => true) },
  };
  const workspace = {
    status: vi.fn(() => ({ configured: true, accessMode: "request", rootName: "Approved", persistent: true, pathDisclosure: "redacted", canonicalPathValidation: "available" })),
    assertPathAllowed: vi.fn((path: string) => path.replace(/\\/g, "/")),
  };
  const events = Events.createEventJournal({ capacity: 16 });
  return {
    registry: Commands.createCommandRegistry({ ppro, Protocol, workspace, events }),
    project, ppro, workspace, markers, markerValues, root, bin, clip, parameter, positionParam, positionState, trackItem,
    motionComponent, vectorComponent, textComponent,
    sequence, sequences, settingsState, parameterState, trackState, editor, manager, events,
  };
}

type CaptionHost = ReturnType<typeof advancedHost>;
const previewCaption = (
  value: CaptionHost,
  yOffset: number | null = 0.05,
  coordinateSpace: string | null = "normalized",
) =>
  value.registry.dispatch("captionAnimation.preview", {
    mediaType: "video",
    trackIndex: 0,
    clipIndex: 0,
    ...(yOffset === null ? {} : { yOffset }),
    ...(coordinateSpace === null ? {} : { coordinateSpace }),
  });

describe("advanced stable Premiere UXP workflows", () => {
  it("advertises all ten groups from runtime probes and labels filesystem boundaries", async () => {
    const value = advancedHost();
    const capabilities = await value.registry.capabilities();
    expect(Object.keys(capabilities.commands)).toEqual(expect.arrayContaining([
      "projectSelection.views", "projectSelection.inspect", "markers.inspect", "markers.add",
      "bins.inspect", "bins.create", "sequenceSettings.get", "sequenceSettings.update",
      "project.import", "parameters.inspect", "parameters.keyframeAdd", "trackItem.inspect",
      "trackItem.update", "timeline.insert", "timeline.mogrtPath", "sequences.inspect",
      "sequences.clone", "encoder.preflight", "encoder.sequence", "encoder.file",
    ]));
    expect(capabilities.commands["projectSelection.inspect"]).toMatchObject({ supported: true, readOnly: true });
    expect(capabilities.commands["markers.add"]).toMatchObject({ supported: true, destructive: true, undoable: true });
    expect(capabilities.commands["project.import"]).toMatchObject({ supported: true, workspaceRequired: true, undoable: false });
    expect(capabilities.commands["encoder.sequence"]).toMatchObject({ supported: true, workspaceRequired: true, undoable: false });
  });

  it("uses Project-view selection and completes marker/bin actions with identity and field readback", async () => {
    const value = advancedHost();
    await expect(value.registry.dispatch("projectSelection.views", {})).resolves.toMatchObject({
      count: 1, views: [{ viewId: "view-1", projectId: "project-1", projectName: "Documentary" }],
    });
    await expect(value.registry.dispatch("projectSelection.inspect", { viewId: "view-1" })).resolves.toMatchObject({
      count: 1, items: [{ id: "clip-1", name: "Interview.mov" }], resolver: "project_view_selection",
    });
    await expect(value.registry.dispatch("markers.add", {
      name: "Turn", startSeconds: 3, comments: "Cut here", operationId: "marker-add",
    })).resolves.toMatchObject({ added: true, outcome: "verified", marker: { name: "Turn", startSeconds: 3 } });
    await expect(value.registry.dispatch("markers.update", {
      markerGuid: "marker-1", expectedName: "Beat", name: "Beat updated",
      startSeconds: 2, colorIndex: 4, operationId: "marker-update",
    })).resolves.toMatchObject({
      updated: true, outcome: "verified",
      marker: { guid: "marker-1", name: "Beat updated", startSeconds: 2, colorIndex: 4 },
    });
    await expect(value.registry.dispatch("bins.create", {
      parentBinId: "bin-1", name: "Selects", operationId: "bin-create",
    })).resolves.toMatchObject({ created: true, outcome: "verified", item: { name: "Selects" } });
  });

  it("updates sequence settings, imports workspace media, and automates a typed effect parameter", async () => {
    const value = advancedHost();
    await expect(value.registry.dispatch("sequenceSettings.update", {
      updates: { maximumBitDepth: true, videoFrameRate: 24, videoWidth: 1920, videoHeight: 1080 },
      operationId: "settings-update",
    })).resolves.toMatchObject({
      updated: true, outcome: "verified",
      after: { maximumBitDepth: true, videoFrameRate: 24, videoFrame: { width: 1920, height: 1080 } },
    });
    await expect(value.registry.dispatch("project.import", {
      mode: "files", paths: ["D:/Approved/broll.mov"], targetBinId: "bin-1",
    })).rejects.toMatchObject({ code: "UXP_CONFIRMATION_REQUIRED" });
    await expect(value.registry.dispatch("project.import", {
      mode: "files", paths: ["D:/Approved/broll.mov"], targetBinId: "bin-1",
      confirmNonUndoable: true, operationId: "import-files",
    })).resolves.toMatchObject({
      imported: true, outcome: "committed_unverified", verified: false, requested: 1,
      observedAddedCount: 1, addedItemIds: [expect.stringMatching(/^import-/)],
    });
    await expect(value.registry.dispatch("parameters.set", {
      mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0,
      expectedComponentId: "ADBE Opacity", expectedParamName: "Opacity", value: 80,
      operationId: "parameter-set",
    })).resolves.toMatchObject({ updated: true, outcome: "verified", after: { value: 80 } });
    expect(value.workspace.assertPathAllowed).toHaveBeenCalledWith("D:/Approved/broll.mov", {
      label: "paths[0]", kind: "file",
    });
  });

  it("verifies relative track moves while keeping SequenceEditor transaction limits explicit", async () => {
    const value = advancedHost();
    await expect(value.registry.dispatch("trackItem.update", {
      mediaType: "video", trackIndex: 0, clipIndex: 0, moveBySeconds: 2,
      disabled: true, operationId: "track-move",
    })).resolves.toMatchObject({
      updated: true, outcome: "verified",
      before: { startSeconds: 10, endSeconds: 20, disabled: false },
      after: { startSeconds: 12, endSeconds: 22, disabled: true },
    });
    await expect(value.registry.dispatch("timeline.insert", {
      projectItemId: "clip-1", timeSeconds: 5, videoTrackIndex: 0, audioTrackIndex: 0,
      operationId: "timeline-insert",
    })).resolves.toMatchObject({
      inserted: true, outcome: "committed_unverified", verified: false,
      verificationBoundary: "sequence_editor_transaction",
      operation: { mutatesProject: true, undo: { supported: true } },
    });
    await expect(value.registry.dispatch("timeline.mogrtLibrary", {
      libraryName: "Brand", elementName: "Lower Third", timeSeconds: 5,
      videoTrackIndex: 0, audioTrackIndex: 0, confirmNonUndoable: true,
    })).resolves.toMatchObject({
      inserted: 1, source: "library", outcome: "committed_unverified", verified: false,
      verificationBoundary: "sequence_editor_host_return",
    });
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(2);
  });

  it("uses complete keyframe preflight/readback and reports absent removals as no-ops", async () => {
    const value = advancedHost();
    value.parameterState.keyframes = [1, 2, 3];
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };

    await expect(value.registry.dispatch("parameters.keyframeRemove", { ...target, timeSeconds: 2 }))
      .resolves.toMatchObject({ removed: true, removalRequested: true, outcome: "verified" });
    await expect(value.registry.dispatch("parameters.keyframeRemove", { ...target, timeSeconds: 2 }))
      .resolves.toMatchObject({ removed: false, unchanged: true, outcome: "verified", operation: { mutatesProject: false } });

    value.parameterState.keyframes = [1, 2, 3];
    await expect(value.registry.dispatch("parameters.keyframeRemoveRange", { ...target, timeSeconds: 1.5, endSeconds: 2.5 }))
      .resolves.toMatchObject({ removed: true, removalRequested: true, outcome: "verified" });
    await expect(value.registry.dispatch("parameters.keyframeRemoveRange", { ...target, timeSeconds: 1.5, endSeconds: 2.5 }))
      .resolves.toMatchObject({ removed: false, unchanged: true, outcome: "verified" });

    value.parameterState.keyframes = Array.from({ length: 257 }, (_, index) => index);
    await expect(value.registry.dispatch("parameters.keyframeRemove", { ...target, timeSeconds: 1 }))
      .rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
  });

  it("adds a PointF keyframe from an {x, y} value and verifies the point readback numerically", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };

    const result = await value.registry.dispatch("parameters.keyframeAdd", {
      ...target, timeSeconds: 0.15, value: { x: 0.5, y: 0.555013 }, operationId: "point-key",
    });

    expect(result).toMatchObject({
      added: true, outcome: "verified",
      value: { x: 0.5, y: 0.555013 },
      after: { value: { x: 0.5, y: 0.555013 } },
    });
    const created = value.parameter.createKeyframe.mock.calls[0][0];
    expect(created).toBeInstanceOf(value.ppro.PointF);
    expect(created.x).toBeCloseTo(0.5);
    expect(created.y).toBeCloseTo(0.555013);
  });

  it("rejects non-numeric point coordinates without coercion", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };

    for (const bad of [{ x: null, y: 0.5 }, { x: true, y: 0 }, { x: "0.5", y: 0.5 }, { x: 0.5, y: 0.5, z: 1 }, { x: [0.5], y: 0.5 }, { x: 0.5 }, { x: Number.NaN, y: 1 }]) {
      await expect(value.registry.dispatch("parameters.keyframeAdd", {
        ...target, timeSeconds: 0.15, value: bad,
      })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    }
    await expect(value.registry.dispatch("parameters.set", {
      ...target, value: [0.5, 0.5],
    })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    expect(value.parameter.createKeyframe).not.toHaveBeenCalled();
  });

  it("rejects unknown time_basis instead of silently defaulting", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };

    await expect(value.registry.dispatch("parameters.keyframeAdd", {
      ...target, timeSeconds: 0.15, timeBasis: "source", value: 100,
    })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    expect(value.parameter.createKeyframe).not.toHaveBeenCalled();
  });

  it("recognizes host-wrapped scalar readbacks as plain values", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };
    value.parameter.getValueAtTime.mockImplementation(async () => ({ value: 80 }));

    await expect(value.registry.dispatch("parameters.set", {
      ...target, value: 80, timeSeconds: 1, operationId: "wrap-set",
    })).resolves.toMatchObject({ updated: true, outcome: "verified", after: { value: 80 } });
  });

  it("never confirms a value from an unavailable readback, not even zero", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };
    value.parameter.getValueAtTime.mockImplementation(async () => null);

    const result = await value.registry.dispatch("parameters.keyframeAdd", {
      ...target, timeSeconds: 0.15, value: 0, operationId: "null-read",
    });
    expect(result).toMatchObject({ added: true, outcome: "committed_unverified", verified: false });
  });

  it("treats an empty host object as an unavailable readback", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };
    value.parameter.getValueAtTime.mockImplementation(async () => ({}));

    const result = await value.registry.dispatch("parameters.set", {
      ...target, value: 80, timeSeconds: 1, operationId: "empty-read",
    });
    expect(result).toMatchObject({ updated: true, outcome: "committed_unverified", verified: false });
    expect(result.after.value).toBeNull();
  });

  it("rejects malformed point readbacks instead of coercing them", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };
    value.parameter.getValueAtTime.mockImplementation(async () => [null, 0.5]);

    const result = await value.registry.dispatch("parameters.keyframeAdd", {
      ...target, timeSeconds: 0.15, value: { x: 0.5, y: 0.5 }, operationId: "badpoint-read",
    });
    expect(result).toMatchObject({ added: true, outcome: "committed_unverified", verified: false });
  });

  it("unwraps a wrapped point base for caption previews", async () => {
    const value = advancedHost();
    value.positionParam.getStartValue.mockImplementation(async () => ({ value: { x: 0.5, y: 0.5 } }));

    const result = await previewCaption(value, 0.05);
    expect(result.components.position.baseValue).toEqual({ x: 0.5, y: 0.5 });
  });

  it("refuses a caption preview whose position base is an empty object", async () => {
    const value = advancedHost();
    value.positionParam.getStartValue.mockImplementation(async () => ({ value: {} }));

    await expect(
      value.registry.dispatch("captionAnimation.preview", { mediaType: "video", trackIndex: 0, clipIndex: 0 }),
    ).rejects.toMatchObject({ code: "UXP_TARGET_UNREADABLE" });
  });

  it("resolves remove_keyframe clip_relative against the source in-point", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };
    value.parameterState.keyframes = [3600.15];
    value.parameterState.keyframeValues = [{ seconds: 3600.15, value: 100 }];

    await expect(value.registry.dispatch("parameters.keyframeRemove", {
      ...target, timeSeconds: 0.15, timeBasis: "clip_relative", operationId: "rel-remove",
    })).resolves.toMatchObject({ removed: true, outcome: "verified", timeSeconds: 3600.15, timeBasis: "clip_relative" });
    expect(value.parameterState.keyframes).toEqual([]);
  });

  it("resolves set_interpolation clip_relative against the source in-point", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };

    const result = await value.registry.dispatch("parameters.keyframeInterpolation", {
      ...target, timeSeconds: 0.15, timeBasis: "clip_relative", interpolation: "linear", operationId: "rel-interp",
    });
    expect(result).toMatchObject({ timeBasis: "clip_relative", requestedTimeSeconds: 0.15, timeSeconds: 3600.15 });
  });

  it("rejects retimed or reversed caption clips until supported", async () => {
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };

    const fast = advancedHost();
    const fastPreview = await fast.registry.dispatch("captionAnimation.preview", { ...target });
    fast.trackItem.getSpeed.mockResolvedValue(2);
    await expect(fast.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: fastPreview, confirmApply: true, operationId: "retime-op",
    })).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED" });

    const reversed = advancedHost();
    const reversedPreview = await reversed.registry.dispatch("captionAnimation.preview", { ...target });
    reversed.trackItem.isSpeedReversed.mockResolvedValue(true);
    await expect(reversed.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: reversedPreview, confirmApply: true, operationId: "reverse-op",
    })).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED" });
  });

  it("derives the one-frame rule from the real sequence frame rate", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };

    value.trackState.end = 10.09;
    const twoFrames = await value.registry.dispatch("captionAnimation.preview", { ...target });
    expect(twoFrames.clip.oneFrame).toBe(false);
    expect(twoFrames.clip.frameSeconds).toBeCloseTo(1 / 23.976, 6);

    value.trackState.end = 10.04;
    const oneFrame = await value.registry.dispatch("captionAnimation.preview", { ...target });
    expect(oneFrame.clip.oneFrame).toBe(true);
  });

  it("binds the snapshot to the project and sequence identity", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);

    expect(preview.clip).toMatchObject({ projectId: "project-1", sequenceId: "sequence-1" });
    value.project.guid = "project-2";
    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "stale-proj",
    })).rejects.toMatchObject({ code: "UXP_STALE_SNAPSHOT" });
  });

  it("rejects ambiguous Motion components and duplicate Position params", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    value.motionComponent.getParamCount.mockReturnValue(2);
    value.motionComponent.getParam.mockImplementation(() => value.positionParam);

    await expect(value.registry.dispatch("captionAnimation.preview", { ...target }))
      .rejects.toMatchObject({ code: "UXP_TARGET_AMBIGUOUS" });
  });

  it("refuses non-graphic clips that merely expose Opacity and Motion", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    value.textComponent.getMatchName.mockResolvedValue("AE.ADBE Other");
    value.vectorComponent.getMatchName.mockResolvedValue("AE.ADBE Other");

    await expect(value.registry.dispatch("captionAnimation.preview", { ...target }))
      .rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED" });
  });

  it("never invents a base position when the host value is unreadable", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    value.positionParam.getStartValue.mockResolvedValueOnce(null);

    await expect(value.registry.dispatch("captionAnimation.preview", { ...target }))
      .rejects.toMatchObject({ code: "UXP_TARGET_UNREADABLE" });
  });

  it("refuses when keyframe enumeration exceeds the safe verification bound", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    value.positionState.keyframes = Array.from({ length: 65 }, (_, index) => 10 + index * 0.1);

    await expect(value.registry.dispatch("captionAnimation.preview", { ...target }))
      .rejects.toMatchObject({ code: "UXP_TOO_MANY_KEYS" });
  });

  it("treats a changed base position as a stale snapshot", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    value.positionState.base = { x: 0.7, y: 0.5 };

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "base-op",
    })).rejects.toMatchObject({ code: "UXP_STALE_SNAPSHOT" });
  });

  it("rejects an apply whose yOffset differs from the previewed plan", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value, 0.05);

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.09, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "offset-op",
    })).rejects.toMatchObject({ code: "UXP_STALE_SNAPSHOT" });
    expect(value.parameter.createAddKeyframeAction).not.toHaveBeenCalled();
  });

  it("reports UXP_COMMAND_UNAVAILABLE when the host lacks a PointF factory", async () => {
    const value = advancedHost();
    delete (value.ppro as Record<string, unknown>).PointF;
    await expect(value.registry.dispatch("parameters.keyframeAdd", {
      mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0,
      timeSeconds: 0.15, value: { x: 1, y: 2 },
    })).rejects.toMatchObject({ code: "UXP_COMMAND_UNAVAILABLE" });
  });

  it("resolves clip_relative keyframe time against the clip start and validates duration", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0, paramIndex: 0 };

    const result = await value.registry.dispatch("parameters.keyframeAdd", {
      ...target, timeSeconds: 0.15, timeBasis: "clip_relative", value: 100, operationId: "rel-key",
    });

    expect(result).toMatchObject({ added: true, outcome: "verified", timeBasis: "clip_relative", timeSeconds: 3600.15 });
    expect(value.parameterState.keyframes).toContain(3600.15);

    await expect(value.registry.dispatch("parameters.keyframeAdd", {
      ...target, timeSeconds: 11, timeBasis: "clip_relative", value: 100,
    })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
  });

  it("previews a caption entrance plan without mutating the host", async () => {
    const value = advancedHost();

    const result = await previewCaption(value, 0.05);

    expect(result).toMatchObject({
      preview: true,
      clip: { startSeconds: 10, endSeconds: 20, durationSeconds: 10, oneFrame: false },
      components: {
        opacity: { index: 0, componentId: "ADBE Opacity", paramName: "Opacity" },
        position: { index: 1, componentId: "AE.ADBE Motion", paramName: "Posição" },
      },
      plan: {
        timeBasis: "clip_relative",
        yOffset: 0.05,
        coordinateSpace: "normalized",
        resolvedStartSeconds: 3600,
        resolvedMidSeconds: 3605,
        relativeMidSeconds: 5,
        opacity: [
          { timeSeconds: 3600, value: 0 },
          { timeSeconds: 3605, value: 100 },
        ],
      },
    });
    expect(result.plan.position[0].value.y).toBeCloseTo(0.55, 9);
    expect(result.plan.position[1].value).toEqual({ x: 0.5, y: 0.5 });
    expect(typeof result.snapshotDigest).toBe("string");
    expect(value.parameter.createKeyframe).not.toHaveBeenCalled();
    expect(value.positionParam.createKeyframe).not.toHaveBeenCalled();
  });

  it("applies the entrance pattern in one transaction and verifies the readback", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value, 0.055013);

    const result = await value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized",
      snapshot: preview, confirmApply: true, operationId: "caption-apply-1",
    });

    expect(result).toMatchObject({ applied: true, noop: false, outcome: "verified" });
    expect(value.parameterState.keyframeValues.map((entry) => entry.seconds).sort()).toEqual([3600, 3605]);
    expect(value.parameterState.keyframeValues.find((entry) => entry.seconds === 3600)?.value).toBe(0);
    expect(value.parameterState.keyframeValues.find((entry) => entry.seconds === 3605)?.value).toBe(100);
    expect(value.positionState.keyframes.sort()).toEqual([3600, 3605]);
    const startValue = value.positionState.keyframeValues.find((entry) => entry.seconds === 3600)?.value as { x: number; y: number };
    const midValue = value.positionState.keyframeValues.find((entry) => entry.seconds === 3605)?.value as { x: number; y: number };
    expect(startValue).toEqual({ x: 0.5, y: 0.555013 });
    expect(midValue).toEqual({ x: 0.5, y: 0.5 });
  });

  it("returns a verified no-op when the pattern is already fully applied", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value, 0.055013);
    await value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "caption-apply-1",
    });
    const mutationsBefore = value.parameter.createAddKeyframeAction.mock.calls.length;

    const second = await value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "caption-apply-2",
    });

    expect(second).toMatchObject({ applied: true, noop: true, outcome: "verified" });
    expect(value.parameter.createAddKeyframeAction.mock.calls.length).toBe(mutationsBefore);
  });

  it("rejects a stale snapshot instead of writing against a changed target", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    value.trackState.start = 12;

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "stale-track",
    })).rejects.toMatchObject({ code: "UXP_STALE_SNAPSHOT" });
  });

  it("rejects conflicting existing keyframes inside the animation range", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    value.parameterState.keyframes = [3602];
    const preview = await previewCaption(value);

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "conflict-op",
    })).rejects.toMatchObject({ code: "UXP_KEYS_EXIST" });
  });

  it("requires explicit confirmation before mutating", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview,
    })).rejects.toMatchObject({ code: "UXP_CONFIRMATION_REQUIRED" });
  });

  it("skips one-frame clips while preserving their current appearance", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    value.trackState.end = 10.02;
    const preview = await previewCaption(value);
    expect(preview.clip.oneFrame).toBe(true);

    const result = await value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "oneframe-op",
    });

    expect(result).toMatchObject({ applied: false, skipped: true });
    expect(value.parameter.createAddKeyframeAction).not.toHaveBeenCalled();
  });

  it("compensates its own keys when the position write fails and reports the rollback", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value, 0.055013);
    value.positionParam.createAddKeyframeAction.mockImplementationOnce(() => {
      throw new Error("host rejected point keyframe");
    });

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "rollback-op",
    })).rejects.toMatchObject({ code: "UXP_APPLY_FAILED" });
    expect(value.parameterState.keyframes).toEqual([]);
    expect(value.positionState.keyframes).toEqual([]);
  });

  it("requires an operation id for caption apply", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview, confirmApply: true,
    })).rejects.toMatchObject({ code: "UXP_OPERATION_ID_REQUIRED" });
    expect(value.parameter.createAddKeyframeAction).not.toHaveBeenCalled();
  });

  it("rejects a reused operation id with a different payload instead of replaying", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    const base = { ...target, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "dup-op" };

    await value.registry.dispatch("captionAnimation.apply", { ...base, yOffset: 0.05 });
    await expect(value.registry.dispatch("captionAnimation.apply", { ...base, yOffset: 0.06 }))
      .rejects.toMatchObject({ code: "UXP_OPERATION_CONFLICT" });
  });

  it("replays an identical retried operation without duplicating keys", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    const args = { ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "retry-op" };

    const first = await value.registry.dispatch("captionAnimation.apply", args);
    const second = await value.registry.dispatch("captionAnimation.apply", { ...args });
    expect(second).toMatchObject({ replayed: true, applied: true });
    expect(value.parameterState.keyframes).toEqual([3600, 3605]);
  });

  it("serializes concurrent applies on the same clip instead of racing them", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    const argsFor = (id: string) => ({
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: id,
    });

    const outcomes = await Promise.allSettled([
      value.registry.dispatch("captionAnimation.apply", argsFor("race-1")),
      value.registry.dispatch("captionAnimation.apply", argsFor("race-2")),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const busy = outcomes.filter(
      (outcome) => outcome.status === "rejected" && (outcome.reason as { code?: string }).code === "UXP_TARGET_BUSY",
    );
    expect(fulfilled).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(value.parameterState.keyframes).toEqual([3600, 3605]);
  });

  it("does not call an extra key inside the range a completed pattern", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    await value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "pattern-op",
    });
    value.parameterState.keyframes.push(3602);
    value.parameterState.keyframeValues.push({ seconds: 3602, value: 50 });

    const fresh = await previewCaption(value);
    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: fresh, confirmApply: true, operationId: "pattern-op-2",
    })).rejects.toMatchObject({ code: "UXP_KEYS_EXIST" });
  });

  it("restores the time-varying flags it enabled when compensating", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value, 0.055013);
    value.positionParam.getValueAtTime.mockImplementation(async () => ({ x: 0, y: 0 }));

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.055013, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "vary-op",
    })).rejects.toMatchObject({ code: "UXP_APPLY_FAILED", message: expect.stringContaining("time-varying") });
    expect(value.parameter.isTimeVarying()).toBe(false);
  });

  it("reports success by readback when the transaction throws after writing", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    value.project.lockedAccess.mockImplementationOnce((callback: () => void) => {
      callback();
      throw new Error("commit blew up after applying");
    });

    const result = await value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "postmortem-op",
    });
    expect(result).toMatchObject({ applied: true, noop: false, outcome: "verified" });
    expect(String((result as { note?: unknown }).note)).toContain("verified by readback");
  });

  it("compensates when the transaction throws before writing anything", async () => {
    const value = advancedHost();
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
    const preview = await previewCaption(value);
    value.project.lockedAccess.mockImplementationOnce(() => {
      throw new Error("host rejected the whole transaction");
    });

    await expect(value.registry.dispatch("captionAnimation.apply", {
      ...target, yOffset: 0.05, coordinateSpace: "normalized", snapshot: preview, confirmApply: true, operationId: "txfail-op",
    })).rejects.toMatchObject({ code: "UXP_APPLY_FAILED", message: expect.stringContaining("host rejected the whole transaction") });
    expect(value.parameterState.keyframes).toEqual([]);
    expect(value.positionState.keyframes).toEqual([]);
  });

  it("keeps direct sequence actions unverified with stable result keys and probes host methods", async () => {
    const value = advancedHost();
    for (const [command, resultField] of [
      ["sequences.activate", "activated"],
      ["sequences.open", "opened"],
      ["sequences.close", "closed"],
    ]) {
      await expect(value.registry.dispatch(command, { sequenceId: "sequence-1" }))
        .resolves.toMatchObject({ [resultField]: true, outcome: "committed_unverified", verified: false, verificationBoundary: "host_return" });
    }
    await expect(value.registry.dispatch("sequences.open", { sequenceId: "sequence-1" })).resolves.not.toHaveProperty("opend");
    await expect(value.registry.dispatch("sequenceSettings.update", {
      updates: { videoFrameRate: 241 },
    })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });

    delete (value.project as unknown as Record<string, unknown>).importAEComps;
    await expect(value.registry.capabilities()).resolves.toMatchObject({
      commands: { "project.import": { supported: false } },
    });

    const missingClose = advancedHost();
    Reflect.deleteProperty(missingClose.project, "closeSequence");
    await expect(missingClose.registry.capabilities()).resolves.toMatchObject({
      commands: {
        "sequences.activate": { supported: true },
        "sequences.open": { supported: true },
        "sequences.close": { supported: false },
      },
    });

    await expect(value.registry.dispatch("sequences.createFromMedia", {
      name: "New Assembly", projectItemIds: ["clip-1"], confirmNonUndoable: true,
    })).resolves.toMatchObject({
      created: true, outcome: "committed_unverified", verified: false,
      verificationBoundary: "create_sequence_host_return",
    });
    await expect(value.registry.dispatch("sequences.subsequence", {
      sequenceId: "sequence-1", confirmNonUndoable: true,
    })).resolves.toMatchObject({
      created: true, outcome: "committed_unverified", verified: false,
      verificationBoundary: "create_subsequence_host_return",
    });
  });

  it("bounds ID-targeted sequence lookup before invoking the host mutation", async () => {
    const value = advancedHost();
    value.project.getSequences.mockResolvedValue(Array.from({ length: 1025 }, (_, index) => ({
      guid: `sequence-${index}`,
      name: `Sequence ${index}`,
    })));

    await expect(value.registry.dispatch("sequences.close", { sequenceId: "sequence-1024" }))
      .rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
    expect(value.project.closeSequence).not.toHaveBeenCalled();

    await expect(value.registry.dispatch("sequences.delete", { confirmNonUndoable: true }))
      .rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
    expect(value.project.deleteSequence).not.toHaveBeenCalled();
  });

  it("rejects bounded collection additions before starting a host mutation", async () => {
    const markerValue = advancedHost();
    markerValue.markers.getMarkers.mockReturnValue(Array.from({ length: 2048 }, () => markerValue.markerValues[0]));
    await expect(markerValue.registry.dispatch("markers.add", {
      name: "Over capacity", operationId: "marker-capacity",
    })).rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
    expect(markerValue.markers.createAddMarkerAction).not.toHaveBeenCalled();
    expect(markerValue.project.lockedAccess).not.toHaveBeenCalled();

    const binValue = advancedHost();
    binValue.bin.children = Array.from({ length: 1024 }, () => binValue.clip);
    await expect(binValue.registry.dispatch("bins.create", {
      parentBinId: "bin-1", name: "Over capacity", operationId: "bin-capacity",
    })).rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
    expect(binValue.bin.createBinAction).not.toHaveBeenCalled();
    expect(binValue.project.lockedAccess).not.toHaveBeenCalled();

    const smartBinValue = advancedHost();
    smartBinValue.bin.children = Array.from({ length: 1024 }, () => smartBinValue.clip);
    await expect(smartBinValue.registry.dispatch("bins.createSmart", {
      parentBinId: "bin-1", name: "Over capacity", searchQuery: "label:red",
      operationId: "smart-bin-capacity",
    })).rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
    expect(smartBinValue.bin.createSmartBinAction).not.toHaveBeenCalled();
    expect(smartBinValue.project.lockedAccess).not.toHaveBeenCalled();

    const sequenceValue = advancedHost();
    sequenceValue.project.getSequences.mockResolvedValue(Array.from({ length: 1024 }, (_, index) => ({
      guid: `sequence-${index + 1}`,
      name: `Sequence ${index + 1}`,
    })));
    await expect(sequenceValue.registry.dispatch("sequences.clone", {
      operationId: "sequence-capacity",
    })).rejects.toMatchObject({ code: "UXP_PROJECT_TOO_LARGE" });
    expect(sequenceValue.sequence.createCloneAction).not.toHaveBeenCalled();
    expect(sequenceValue.project.lockedAccess).not.toHaveBeenCalled();
  });

  it("serializes distinct append operations against each target capacity", async () => {
    const markerValue = advancedHost();
    markerValue.markerValues.push(...Array.from({ length: 2046 }, () => markerValue.markerValues[0]));
    const markerResults = await Promise.allSettled([
      markerValue.registry.dispatch("markers.add", { name: "First", operationId: "marker-first" }),
      markerValue.registry.dispatch("markers.add", { name: "Second", operationId: "marker-second" }),
    ]);
    expect(markerResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(markerResults.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "UXP_PROJECT_TOO_LARGE" } });
    expect(markerValue.markers.createAddMarkerAction).toHaveBeenCalledOnce();
    expect(markerValue.markerValues).toHaveLength(2048);

    const binValue = advancedHost();
    binValue.bin.children = Array.from({ length: 1023 }, () => binValue.clip);
    const binResults = await Promise.allSettled([
      binValue.registry.dispatch("bins.create", {
        parentBinId: "bin-1", name: "Regular", operationId: "bin-first",
      }),
      binValue.registry.dispatch("bins.createSmart", {
        parentBinId: "bin-1", name: "Smart", searchQuery: "label:red", operationId: "bin-second",
      }),
    ]);
    expect(binResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(binResults.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "UXP_PROJECT_TOO_LARGE" } });
    expect((binValue.bin.createBinAction?.mock.calls.length || 0) + (binValue.bin.createSmartBinAction?.mock.calls.length || 0)).toBe(1);
    expect(binValue.bin.children).toHaveLength(1024);

    const sequenceValue = advancedHost();
    sequenceValue.sequences.push(...Array.from({ length: 1022 }, (_, index) => ({
      guid: `existing-sequence-${index}`,
      name: `Existing Sequence ${index}`,
    })));
    const sequenceResults = await Promise.allSettled([
      sequenceValue.registry.dispatch("sequences.clone", { operationId: "sequence-first" }),
      sequenceValue.registry.dispatch("sequences.clone", { operationId: "sequence-second" }),
    ]);
    expect(sequenceResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(sequenceResults.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "UXP_PROJECT_TOO_LARGE" } });
    expect(sequenceValue.sequence.createCloneAction).toHaveBeenCalledOnce();
    expect(sequenceValue.sequences).toHaveLength(1024);
  });

  it("clones sequences with identity readback and gates AME writes on explicit confirmation", async () => {
    const value = advancedHost();
    await expect(value.registry.dispatch("sequences.clone", {
      sequenceId: "sequence-1", operationId: "sequence-clone",
    })).resolves.toMatchObject({
      cloned: true, outcome: "verified", source: { id: "sequence-1" },
      sequence: { id: "sequence-2", name: "Assembly Copy" },
    });
    await expect(value.registry.dispatch("encoder.sequence", {
      sequenceId: "sequence-1", exportType: "queueToAme",
      outputFile: "D:/Approved/output.mp4", presetFile: "D:/Approved/h264.epr",
    })).rejects.toMatchObject({ code: "UXP_CONFIRMATION_REQUIRED" });
    await expect(value.registry.dispatch("encoder.sequence", {
      sequenceId: "sequence-1", exportType: "queueToAme",
      outputFile: "D:/Approved/output.mp4", presetFile: "D:/Approved/h264.epr",
      confirmExternalWrite: true, operationId: "encode-sequence",
    })).resolves.toMatchObject({
      queued: true, kind: "sequence", outcome: "committed_unverified", verified: false,
      verificationBoundary: "encoder_host_return",
      encodeJob: { jobId: "encode-sequence", state: "accepted", terminal: false },
    });
    expect(value.manager.exportSequence).toHaveBeenCalledWith(
      expect.objectContaining({ guid: "sequence-1" }), "ame",
      "D:/Approved/output.mp4", "D:/Approved/h264.epr", true,
    );
    value.events.recordHostEvent({ category: "encoder", name: "encoder.queued" });
    value.events.recordHostEvent({ category: "encoder", name: "encoder.complete" });
    await expect(value.registry.dispatch("encoder.wait", {
      jobId: "encode-sequence", timeoutMs: 100,
    })).resolves.toMatchObject({
      timedOut: false,
      job: { state: "completed", terminal: true, verificationBoundary: "encoder_terminal_event_only" },
    });

    const noProject = advancedHost();
    noProject.ppro.Project.getActiveProject.mockResolvedValue(null);
    await expect(noProject.registry.dispatch("encoder.preflight", {})).resolves.toEqual({
      ameInstalled: true, extension: null, sequenceId: null,
    });
  });
});

describe("caption entrance single-project guard", () => {
  it("names the live project on every preview", async () => {
    const value = advancedHost();
    const preview = await previewCaption(value);
    expect(preview.clip.projectId).toBe("project-1");
    expect(preview.clip.projectName).toBe("Documentary");
  });

  it("refuses a snapshot from another project and names both sides", async () => {
    const first = advancedHost();
    const preview = await previewCaption(first);
    expect(preview.clip.projectName).toBe("Documentary");

    const second = advancedHost();
    second.project.guid = "project-2";
    second.project.name = "Strawberry";
    await expect(second.registry.dispatch("captionAnimation.apply", {
      mediaType: "video",
      trackIndex: 0,
      clipIndex: 0,
      yOffset: 0.05,
      coordinateSpace: "normalized",
      confirmApply: true,
      operationId: "cross-project",
      snapshot: preview,
    })).rejects.toMatchObject({
      code: "UXP_STALE_SNAPSHOT",
      message: expect.stringContaining("Documentary"),
    });
    await expect(second.registry.dispatch("captionAnimation.apply", {
      mediaType: "video",
      trackIndex: 0,
      clipIndex: 0,
      yOffset: 0.05,
      coordinateSpace: "normalized",
      confirmApply: true,
      operationId: "cross-project-2",
      snapshot: preview,
    })).rejects.toSatisfy((error: unknown) =>
      (error as Error).message.includes("Documentary")
      && (error as Error).message.includes("Strawberry"));
  });

  it("still applies a same-project snapshot after the guard reorder", async () => {
    const value = advancedHost();
    const preview = await previewCaption(value, 0.055013);
    const result = await value.registry.dispatch("captionAnimation.apply", {
      mediaType: "video",
      trackIndex: 0,
      clipIndex: 0,
      yOffset: 0.055013,
      coordinateSpace: "normalized",
      confirmApply: true,
      operationId: "same-project-guard",
      snapshot: preview,
    });
    expect(result.outcome).toBe("verified");
  });
});
