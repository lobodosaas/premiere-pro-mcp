import { describe, expect, it } from "vitest";
import {
  buildToolPackReport,
  isToolInSelectedPacks,
  resolveToolPacks,
} from "../../src/workflows/tool-packs.js";

describe("workflow tool packs", () => {
  it("keeps the backwards-compatible full catalog when unconfigured", () => {
    expect(resolveToolPacks(undefined, "default")).toEqual({
      source: "default",
      selected: [],
      fullCatalog: true,
    });
  });

  it("unions explicit packs without granting tools outside them", () => {
    const selection = resolveToolPacks("essential, delivery, essential", "explicit");
    expect(selection).toMatchObject({
      source: "explicit",
      selected: ["essential", "delivery"],
      fullCatalog: false,
    });
    expect(isToolInSelectedPacks("get_project_info", selection)).toBe(true);
    expect(isToolInSelectedPacks("export_aaf", selection)).toBe(true);
    expect(isToolInSelectedPacks("create_bin", selection)).toBe(false);

    const report = buildToolPackReport(selection);
    expect(report.selected).toEqual(["essential", "delivery"]);
    expect(report.note).toContain("do not grant capabilities");
  });

  it("rejects ambiguous or unknown configuration", () => {
    expect(() => resolveToolPacks("full,inspection", "explicit")).toThrow(/cannot combine/i);
    expect(() => resolveToolPacks("unknown", "explicit")).toThrow(/Unknown Premiere MCP tool pack/i);
    expect(() => resolveToolPacks(",", "explicit")).toThrow(/must select full or at least one pack/i);
  });

  it("exposes the narrow animation pack for caption entrance work", () => {
    const selection = resolveToolPacks("essential, animation", "explicit");
    expect(selection).toMatchObject({ source: "explicit", selected: ["essential", "animation"], fullCatalog: false });

    for (const tool of [
      "get_effect_properties",
      "get_keyframes",
      "add_keyframe",
      "remove_keyframe",
      "remove_keyframe_range",
      "set_keyframe_interpolation",
      "get_value_at_time",
      "set_effect_property",
      "automate_effect_parameters_uxp",
      "animate_caption_clip_uxp",
    ]) {
      expect(isToolInSelectedPacks(tool, selection)).toBe(true);
    }

    // The animation pack stays narrow: no scripting or broad timeline
    // mutations ride along with it (delivery tools come from essential).
    for (const tool of ["execute_extendscript", "send_raw_script", "add_to_timeline", "ripple_delete"]) {
      expect(isToolInSelectedPacks(tool, selection)).toBe(false);
    }
  });
});
