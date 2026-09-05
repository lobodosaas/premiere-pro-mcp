import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand, BridgeOptions } from "../bridge/file-bridge.js";

export function getKeyframeTools(bridgeOptions: BridgeOptions) {
  return {
    get_effect_properties: {
      description: "List all properties of a specific effect on a clip, including current values",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect (e.g., 'Motion', 'Opacity', 'Lumetri Color')",
          },
        },
        required: ["node_id", "effect_name"],
      },
      handler: async (args: { node_id: string; effect_name: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          var comp = null;
          
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === effectName || clip.components[i].matchName === effectName) {
              comp = clip.components[i];
              break;
            }
          }
          
          if (!comp) return __error("Effect not found: " + effectName);
          
          var props = [];
          for (var p = 0; p < comp.properties.numItems; p++) {
            var prop = comp.properties[p];
            var info = {
              index: p,
              displayName: prop.displayName,
              isTimeVarying: false,
              keyframesSupported: false
            };
            try { info.isTimeVarying = prop.isTimeVarying(); } catch(e) {}
            try { info.keyframesSupported = prop.areKeyframesSupported(); } catch(e) {}
            try { info.value = prop.getValue(0, 0); } catch(e) {}
            props.push(info);
          }
          
          return __result({
            effect: comp.displayName,
            matchName: comp.matchName,
            properties: props
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_effect_property: {
      description: "Set the value of a specific effect property on a clip. " +
        "CAUTION: matching is by FIRST displayName occurrence — when a component has duplicate names (e.g., several 'Text' params in MOGRTs), this writes to the first one, which may be an internal GUID param. Inspect with get_effect_properties / list_clip_effects and confirm the target is unique before writing.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect (e.g., 'Motion', 'Opacity')",
          },
          property_name: {
            type: "string",
            description: "Display name of the property (e.g., 'Scale', 'Position', 'Opacity')",
          },
          value: {
            type: ["number", "string", "array"],
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
            maxLength: 8192,
            description: "Number, string, or two-element [x, y] array value to set. Use the exact JSON string reported for a MOGRT text or graphic parameter; use [x, y] for 2D properties such as Position.",
          },
        },
        required: ["node_id", "effect_name", "property_name", "value"],
      },
      handler: async (args: { node_id: string; effect_name: string; property_name: string; value: number | string | [number, number] }) => {
        const valueIsArray = Array.isArray(args.value);
        if (valueIsArray) {
          const entries: unknown = args.value;
          if (!Array.isArray(entries) || entries.length !== 2 || !entries.every((entry: unknown) => typeof entry === "number")) {
            return { success: false, error: "Array values must be a two-element [x, y] array of numbers; no mutation was attempted." };
          }
        }
        const requestedValue = valueIsArray
          ? "[" + (args.value as [number, number]).join(", ") + "]"
          : typeof args.value === "string"
            ? `"${escapeForExtendScript(args.value)}"`
            : String(args.value);
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found: ${escapeForExtendScript(args.effect_name)}");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found: ${escapeForExtendScript(args.property_name)}");
          
          var requestedValue = ${requestedValue};
          var requestedIsArray = ${valueIsArray};
          try {
            prop.setValue(requestedValue, true);
          } catch (e) {
            return __error("Premiere could not set the requested effect property: " + e.toString());
          }

          var readbackValue;
          var readbackAvailable = true;
          try {
            readbackValue = prop.getValue();
          } catch (eReadback) {
            readbackAvailable = false;
          }
          var readbackVerified = readbackAvailable && readbackValue === requestedValue;
          if (readbackAvailable && requestedIsArray) {
            readbackVerified = readbackValue && typeof readbackValue.length === "number" && readbackValue.length === requestedValue.length &&
              readbackValue.every(function(entry, index) { return Math.abs(entry - requestedValue[index]) <= 0.0001; });
          }
          return __result({
            set: true,
            effect: "${escapeForExtendScript(args.effect_name)}",
            property: "${escapeForExtendScript(args.property_name)}",
            value: readbackAvailable ? readbackValue : requestedValue,
            requestedValue: requestedValue,
            readbackVerified: readbackVerified,
            verification: readbackAvailable
              ? "Premiere parameter readback only; verify playback or exported frames before delivery."
              : "Premiere accepted the parameter write, but this property did not expose a readback value. Verify playback or exported frames before delivery."
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    get_keyframes: {
      description: "Get all keyframes for a specific effect property on a clip",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect",
          },
          property_name: {
            type: "string",
            description: "Display name of the property",
          },
        },
        required: ["node_id", "effect_name", "property_name"],
      },
      handler: async (args: { node_id: string; effect_name: string; property_name: string }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found");
          
          var isTimeVarying = false;
          try { isTimeVarying = prop.isTimeVarying(); } catch(e) {}
          
          if (!isTimeVarying) {
            return __result({ keyframes: [], isTimeVarying: false, message: "Property has no keyframes" });
          }
          
          var keys = prop.getKeys();
          var keyframes = [];
          if (keys) {
            for (var k = 0; k < keys.length; k++) {
              var time = keys[k];
              var val = null;
              try { val = prop.getValueAtKey(time); } catch(e) {}
              keyframes.push({
                time: __ticksToSeconds(time.ticks),
                value: val
              });
            }
          }
          
          return __result({
            effect: "${escapeForExtendScript(args.effect_name)}",
            property: "${escapeForExtendScript(args.property_name)}",
            isTimeVarying: true,
            keyframes: keyframes
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    add_keyframe: {
      description:
        "Add and read back a keyframe on an effect property. Accepts a scalar number (e.g. Opacity, Scale) or a two-element [x, y] array for 2D properties (e.g. Position). This verifies stored parameter data only; render/playback verification remains host-dependent.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect",
          },
          property_name: {
            type: "string",
            description: "Display name of the property",
          },
          time_seconds: {
            type: "number",
            description: "Time in seconds relative to clip start where to add keyframe",
          },
          value: {
            type: ["number", "string", "array"],
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
            description: "Value at the keyframe: a finite number, a two-element [x, y] array of finite numbers for 2D properties such as Position, or the same array as a JSON string (some transports stringify arrays)",
          },
        },
        required: ["node_id", "effect_name", "property_name", "time_seconds", "value"],
      },
      handler: async (args: {
        node_id: string;
        effect_name: string;
        property_name: string;
        time_seconds: number;
        value: number | string | [number, number];
      }) => {
        if (!Number.isFinite(args.time_seconds) || args.time_seconds < 0) {
          return { success: false, error: "time_seconds must be a finite non-negative time relative to clip start." };
        }
        const rawValue: unknown = args.value as unknown;
        const valueIsValidScalar = typeof rawValue === "number" && Number.isFinite(rawValue);
        // Some MCP transports stringify arrays (e.g. "[0.5, 0.555013]"); accept that form too.
        let arrayCandidate: unknown = rawValue;
        if (typeof arrayCandidate === "string") {
          try {
            arrayCandidate = JSON.parse(arrayCandidate);
          } catch {
            arrayCandidate = null;
          }
        }
        const valueIsValidArray =
          Array.isArray(arrayCandidate) &&
          arrayCandidate.length === 2 &&
          arrayCandidate.every((entry: unknown) => typeof entry === "number" && Number.isFinite(entry));
        if (!valueIsValidScalar && !valueIsValidArray) {
          return { success: false, error: "value must be a finite number or a two-element [x, y] array of finite numbers." };
        }
        const valueIsArray = valueIsValidArray;
        const valueLiteral = valueIsArray
          ? "[" + (arrayCandidate as [number, number]).join(", ") + "]"
          : String(rawValue);
        const valueX = valueIsArray ? (arrayCandidate as [number, number])[0] : NaN;
        const valueY = valueIsArray ? (arrayCandidate as [number, number])[1] : NaN;
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var relativeSeconds = ${args.time_seconds};
          var clipInPointSeconds = NaN;
          var clipDurationSeconds = NaN;
          try {
            clipInPointSeconds = __ticksToSeconds(clip.inPoint.ticks);
            clipDurationSeconds = __ticksToSeconds(clip.duration.ticks);
          } catch(eTiming) {}
          if (!isFinite(clipInPointSeconds) || !isFinite(clipDurationSeconds) || clipDurationSeconds <= 0) {
            return __error("Premiere did not provide readable clip timing; no keyframe was written.");
          }
          if (relativeSeconds >= clipDurationSeconds) {
            return __error("time_seconds is outside the visible clip duration; no keyframe was written.");
          }
          var resolvedPropertyTimeSeconds = clipInPointSeconds + relativeSeconds;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found");
          try {
            if (!prop.areKeyframesSupported()) return __error("Property does not support keyframes");
          } catch(eSupports) {}
          
          // Enable keyframes if not already
          try {
            if (!prop.isTimeVarying()) {
              prop.setTimeVarying(true);
            }
          } catch(e) {}
          
          var time = new Time();
          time.ticks = __secondsToTicks(resolvedPropertyTimeSeconds).toString();
          var addResult = prop.addKey(time);
          var storedAtResolvedTime = false;
          var keysAfterAdd = prop.getKeys();
          if (keysAfterAdd) {
            for (var keyIndex = 0; keyIndex < keysAfterAdd.length; keyIndex++) {
              if (String(keysAfterAdd[keyIndex].ticks) === String(time.ticks)) {
                storedAtResolvedTime = true;
                break;
              }
            }
          }
          if (!storedAtResolvedTime) {
            return __error("Premiere did not return a keyframe at the resolved property time; storage is not reported as verified.");
          }
          var requestedIsArray = ${valueIsArray};
          var setResult = prop.setValueAtKey(time, ${valueLiteral}, true);
          var readBack = null;
          try { readBack = prop.getValueAtKey(time); } catch(eReadBack) {}
          if (requestedIsArray) {
            var arrayMatch = readBack && typeof readBack.length === "number" && readBack.length === 2 &&
              Math.abs(readBack[0] - ${valueX}) <= 0.0001 && Math.abs(readBack[1] - ${valueY}) <= 0.0001;
            if (!arrayMatch) {
              return __error("Premiere did not return the requested [x, y] keyframe value after writing it; storage is not reported as verified.");
            }
          } else {
            if (typeof readBack !== "number" || !isFinite(readBack)) {
              return __error("Premiere did not return a finite numeric keyframe value after writing it; storage is not reported as verified.");
            }
            if (Math.abs(readBack - ${valueLiteral}) > 0.0001) {
              return __error("Premiere returned " + readBack + " after writing keyframe value ${valueLiteral}; storage is not reported as verified.");
            }
          }
          
          return __result({
            added: true,
            stored: true,
            renderVerified: false,
            verificationScope: "Premiere parameter readback only; verify playback or exported frames before relying on visual output.",
            effect: "${escapeForExtendScript(args.effect_name)}",
            property: "${escapeForExtendScript(args.property_name)}",
            time: ${args.time_seconds},
            relativeTimeSeconds: relativeSeconds,
            resolvedPropertyTimeSeconds: resolvedPropertyTimeSeconds,
            clipInPointSeconds: clipInPointSeconds,
            keyframeTimeVerified: true,
            addKeyReturn: typeof addResult === "undefined" ? null : addResult,
            setValueAtKeyReturn: typeof setResult === "undefined" ? null : setResult,
            value: ${valueLiteral},
            readBackValue: readBack
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    remove_keyframe: {
      description: "Remove a keyframe at a specific time from an effect property. Time is relative to clip start; removal is verified by readback and never reported from the host call alone.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect",
          },
          property_name: {
            type: "string",
            description: "Display name of the property",
          },
          time_seconds: {
            type: "number",
            description: "Time in seconds relative to clip start of the keyframe to remove",
          },
        },
        required: ["node_id", "effect_name", "property_name", "time_seconds"],
      },
      handler: async (args: { node_id: string; effect_name: string; property_name: string; time_seconds: number }) => {
        if (!Number.isFinite(args.time_seconds) || args.time_seconds < 0) {
          return { success: false, error: "time_seconds must be a finite non-negative time relative to clip start." };
        }
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var relativeSeconds = ${args.time_seconds};
          var clipInPointSeconds = NaN;
          var clipDurationSeconds = NaN;
          try {
            clipInPointSeconds = __ticksToSeconds(clip.inPoint.ticks);
            clipDurationSeconds = __ticksToSeconds(clip.duration.ticks);
          } catch(eTiming) {}
          if (!isFinite(clipInPointSeconds) || !isFinite(clipDurationSeconds) || clipDurationSeconds <= 0) {
            return __error("Premiere did not provide readable clip timing; no keyframe was removed.");
          }
          if (relativeSeconds > clipDurationSeconds) {
            return __error("time_seconds is outside the visible clip duration; no keyframe was removed.");
          }
          var resolvedPropertyTimeSeconds = clipInPointSeconds + relativeSeconds;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found");
          
          var time = new Time();
          time.ticks = __secondsToTicks(resolvedPropertyTimeSeconds).toString();
          prop.removeKey(time);
          var stillPresent = false;
          var keysAfterRemove = prop.getKeys();
          if (keysAfterRemove) {
            for (var keyIndex = 0; keyIndex < keysAfterRemove.length; keyIndex++) {
              if (String(keysAfterRemove[keyIndex].ticks) === String(time.ticks)) {
                stillPresent = true;
                break;
              }
            }
          }
          if (stillPresent) {
            return __error("Premiere still returns a keyframe at the resolved property time; removal is not reported as verified.");
          }
          
          return __result({
            removed: true,
            removedVerified: true,
            effect: "${escapeForExtendScript(args.effect_name)}",
            property: "${escapeForExtendScript(args.property_name)}",
            time: ${args.time_seconds},
            relativeTimeSeconds: relativeSeconds,
            resolvedPropertyTimeSeconds: resolvedPropertyTimeSeconds,
            clipInPointSeconds: clipInPointSeconds
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    remove_keyframe_range: {
      description: "Remove all keyframes in a time range from an effect property",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect",
          },
          property_name: {
            type: "string",
            description: "Display name of the property",
          },
          start_seconds: {
            type: "number",
            description: "Start of the range in seconds",
          },
          end_seconds: {
            type: "number",
            description: "End of the range in seconds",
          },
        },
        required: ["node_id", "effect_name", "property_name", "start_seconds", "end_seconds"],
      },
      handler: async (args: {
        node_id: string;
        effect_name: string;
        property_name: string;
        start_seconds: number;
        end_seconds: number;
      }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found");
          
          var startTime = new Time();
          startTime.ticks = __secondsToTicks(${args.start_seconds}).toString();
          var endTime = new Time();
          endTime.ticks = __secondsToTicks(${args.end_seconds}).toString();
          prop.removeKeyRange(startTime, endTime);
          
          return __result({
            removed: true,
            effect: "${escapeForExtendScript(args.effect_name)}",
            property: "${escapeForExtendScript(args.property_name)}",
            range: { start: ${args.start_seconds}, end: ${args.end_seconds} }
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_keyframe_interpolation: {
      description: "Set the interpolation type of a keyframe (Linear, Hold, or Bezier)",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect",
          },
          property_name: {
            type: "string",
            description: "Display name of the property",
          },
          time_seconds: {
            type: "number",
            description: "Time in seconds of the keyframe",
          },
          interpolation: {
            type: "string",
            enum: ["linear", "hold", "bezier"],
            description: "Interpolation type",
          },
        },
        required: ["node_id", "effect_name", "property_name", "time_seconds", "interpolation"],
      },
      handler: async (args: {
        node_id: string;
        effect_name: string;
        property_name: string;
        time_seconds: number;
        interpolation: string;
      }) => {
        const interpMap: Record<string, number> = { linear: 0, hold: 4, bezier: 5 };
        const interpType = interpMap[args.interpolation] ?? 0;

        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found");
          
          var time = new Time();
          time.ticks = __secondsToTicks(${args.time_seconds}).toString();
          prop.setInterpolationTypeAtKey(time, ${interpType}, true);
          
          return __result({
            set: true,
            interpolation: "${args.interpolation}",
            time: ${args.time_seconds}
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    get_value_at_time: {
      description: "Get the interpolated value of an effect property at a specific time",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Display name of the effect",
          },
          property_name: {
            type: "string",
            description: "Display name of the property",
          },
          time_seconds: {
            type: "number",
            description: "Time in seconds to query the value at",
          },
        },
        required: ["node_id", "effect_name", "property_name", "time_seconds"],
      },
      handler: async (args: { node_id: string; effect_name: string; property_name: string; time_seconds: number }) => {
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var comp = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "${escapeForExtendScript(args.effect_name)}" || clip.components[i].matchName === "${escapeForExtendScript(args.effect_name)}") {
              comp = clip.components[i];
              break;
            }
          }
          if (!comp) return __error("Effect not found");
          
          var prop = null;
          for (var p = 0; p < comp.properties.numItems; p++) {
            if (comp.properties[p].displayName === "${escapeForExtendScript(args.property_name)}") {
              prop = comp.properties[p];
              break;
            }
          }
          if (!prop) return __error("Property not found");
          
          var time = new Time();
          time.ticks = __secondsToTicks(${args.time_seconds}).toString();
          var value = prop.getValueAtTime(time);
          
          return __result({
            effect: "${escapeForExtendScript(args.effect_name)}",
            property: "${escapeForExtendScript(args.property_name)}",
            time: ${args.time_seconds},
            value: value
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },
  };
}
