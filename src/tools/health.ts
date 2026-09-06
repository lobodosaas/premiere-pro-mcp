import { buildToolScript } from "../bridge/script-builder.js";
import { getTempDir, sendCommand, BridgeOptions } from "../bridge/file-bridge.js";
import type { BrokerRuntimeReport } from "../bridge/broker-heartbeat.js";
import { isToolPermitted, resolveCapabilities, type CapabilityConfig } from "../security/capabilities.js";
import type { ServerBuildInfo } from "../build-info.js";
import { buildPlatformCapabilityReport } from "../platform-capabilities.js";
import { buildAdvancedFeatureSupport, type AdvancedFeatureBackend } from "../advanced-feature-support.js";
import type { CatalogToolDefinition } from "../tool-capability-report.js";
import { buildFirstRunReport, type FirstRunReport } from "../diagnostics.js";
import { captureActivationEvent, type Telemetry } from "../telemetry.js";
import type { UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";
import {
  buildToolPackReport,
  isToolInSelectedPacks,
  resolveToolPacks,
  type ToolPackSelection,
} from "../workflows/tool-packs.js";

export interface HealthToolOptions {
  telemetry?: Telemetry;
  uxpBridge?: UxpWebSocketBridge;
  toolPacks?: ToolPackSelection;
  buildInfo?: ServerBuildInfo;
  /** Broker self-report for endpoint diagnosis; absent outside broker mode. */
  brokerReport?: () => BrokerRuntimeReport | null;
}

const disabledTelemetry: Telemetry = {
  enabled: false,
  capture: () => {},
  shutdown: async () => {},
};

type UxpDiagnostic = NonNullable<FirstRunReport["uxpDiagnostic"]>;

/**
 * Summarize the connected UXP panel without leaking tokens, paths, or the
 * full command map. A listener without a panel handshake is reported as
 * disconnected, never as verified.
 */
function summarizeUxpPanel(bridge: UxpWebSocketBridge | undefined): Record<string, unknown> {
  if (!bridge || typeof bridge.getState !== "function") {
    return { connected: false, status: "no_bridge" };
  }
  try {
    const state = bridge.getState();
    if (state.connected) {
      const hello = state.capabilities as { hostVersion?: unknown; panelVersion?: unknown; commands?: Record<string, { supported?: unknown }> };
      const commands = hello?.commands && typeof hello.commands === "object" ? hello.commands : {};
      return {
        connected: true,
        status: state.status,
        protocolVersion: state.protocolVersion,
        hostVersion: typeof hello?.hostVersion === "string" ? hello.hostVersion : null,
        panelVersion: typeof hello?.panelVersion === "string" ? hello.panelVersion : null,
        supportedCommandCount: Object.values(commands).filter((command) => command?.supported === true).length,
        connectedAt: state.connectedAt,
      };
    }
    return { connected: false, status: state.status };
  } catch {
    return { connected: false, status: "unknown" };
  }
}

function buildUxpDiagnostic(
  bridge: UxpWebSocketBridge | undefined,
  error: unknown,
): UxpDiagnostic {
  let connected = false;
  let latest: UxpDiagnostic["latest"] = null;

  if (bridge && typeof bridge.getState === "function") {
    try {
      const state = bridge.getState();
      connected = state.connected === true;
      const records = state.connected ? state.diagnostics?.records : undefined;
      const record = records && records.length > 0 ? records[records.length - 1] : undefined;
      if (record) latest = { command: record.command, phase: record.phase };
    } catch {
      // A diagnostic read must never hide the original safe-check failure.
    }
  }

  const errorCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return {
    errorCode: typeof errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)
      ? errorCode
      : "UXP_CHECK_FAILED",
    connected,
    latest,
  };
}

export function getHealthTools(
  bridgeOptions: BridgeOptions,
  capabilities: CapabilityConfig = resolveCapabilities(),
  getToolCatalog: () => Record<string, CatalogToolDefinition> = () => ({}),
  options: HealthToolOptions = {},
) {
  return {
    get_advanced_feature_support: {
      description:
        "Report public-API support, prerequisites, entitlements, and user-assisted boundaries for Premiere collaboration and AI features",
      parameters: {
        type: "object" as const,
        properties: {
          backend: {
            type: "string",
            enum: ["cep", "uxp"],
            description: "Backend being evaluated (default: cep, the current production MCP transport)",
          },
          premiere_version: {
            type: "string",
            description: "Optional Premiere version such as 26.3.0 for version-specific eligibility",
          },
          frameio_entitled: {
            type: "boolean",
            description: "Whether the operator has confirmed Frame.io account/project access",
          },
          generative_ai_entitled: {
            type: "boolean",
            description: "Whether the operator has confirmed Adobe generative AI entitlement",
          },
          network_available: {
            type: "boolean",
            description: "Whether required Adobe/cloud services are reachable",
          },
        },
      },
      handler: async (args: {
        backend?: AdvancedFeatureBackend;
        premiere_version?: string;
        frameio_entitled?: boolean;
        generative_ai_entitled?: boolean;
        network_available?: boolean;
      }) => {
        try {
          return {
            success: true,
            data: buildAdvancedFeatureSupport({
              backend: args.backend,
              premiereVersion: args.premiere_version,
              frameIoEntitled: args.frameio_entitled,
              generativeAiEntitled: args.generative_ai_entitled,
              networkAvailable: args.network_available,
            }),
          };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    get_capabilities: {
      description: "Report Windows/macOS support, Premiere Pro backend coverage, enabled authority, and whether live host verification is still required. Use tool_names or tool_offset/tool_limit to return a bounded tool catalog.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          tool_names: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 256 },
            minItems: 1,
            maxItems: 128,
            uniqueItems: true,
            description: "Optional exact tool-name allowlist. Returns only those catalog entries while retaining the overall capability summary.",
          },
          tool_offset: {
            type: "integer",
            minimum: 0,
            description: "Zero-based offset into the filtered tool catalog. Pair with tool_limit for an explicitly sized page.",
          },
          tool_limit: {
            type: "integer",
            minimum: 1,
            maximum: 128,
            description: "Maximum tool catalog entries to return. Omit with tool_offset to preserve the complete legacy response.",
          },
        },
      },
      handler: async (args: { tool_names?: string[]; tool_offset?: number; tool_limit?: number } = {}) => {
        const toolPacks = options.toolPacks ?? resolveToolPacks();
        const report = buildPlatformCapabilityReport(
          capabilities,
          process.platform,
          getTempDir(bridgeOptions),
          getToolCatalog(),
          buildToolPackReport(toolPacks),
        );
        const names = Array.isArray(args.tool_names) ? new Set(args.tool_names) : undefined;
        const matchingTools = names
          ? report.tools.tools.filter((tool) => names.has(tool.name))
          : report.tools.tools;
        const offset = Number.isInteger(args.tool_offset) && (args.tool_offset as number) >= 0 ? args.tool_offset as number : 0;
        const hasExplicitPage = args.tool_limit !== undefined || args.tool_offset !== undefined;
        const limit = Number.isInteger(args.tool_limit) && (args.tool_limit as number) > 0
          ? Math.min(args.tool_limit as number, 128)
          : matchingTools.length;
        const page = hasExplicitPage ? matchingTools.slice(offset, offset + limit) : matchingTools;
        // Annotate the pre-filter catalog with effective registration so an
        // operator can tell "implemented" from "actually listed to this client".
        const registeredPage = page.map((tool) => ({
          ...tool,
          registered: isToolPermitted(tool.name, capabilities)
            && isToolInSelectedPacks(tool.name, toolPacks),
        }));

        return {
          success: true,
          data: {
            ...report,
            runtime: {
              ...report.runtime,
              build: options.buildInfo ?? {
                found: false,
                commit: null,
                packageVersion: null,
                builtAt: null,
                source: "missing",
              },
              broker: options.brokerReport?.() ?? { present: false },
              toolPacks: {
                selected: toolPacks.fullCatalog ? ["full"] : [...toolPacks.selected],
                fullCatalog: toolPacks.fullCatalog,
              },
              uxp: summarizeUxpPanel(options.uxpBridge),
            },
            tools: {
              ...report.tools,
              tools: registeredPage,
              ...(names || hasExplicitPage
                ? {
                    pagination: {
                      offset,
                      limit,
                      returned: registeredPage.length,
                      totalMatching: matchingTools.length,
                      hasMore: offset + registeredPage.length < matchingTools.length,
                      nextOffset: offset + registeredPage.length < matchingTools.length ? offset + registeredPage.length : null,
                    },
                  }
                : {}),
            },
          },
        };
      },
    },
    ping: {
      description: "Health check — verify the CEP plugin is running and connected to Premiere Pro. Call this before other tools to confirm connectivity.",
      parameters: {},
      handler: async () => {
        const script = buildToolScript(`
          var version = app.version;
          var projectName = app.project && app.project.name ? app.project.name : "No project open";
          var activeSequence = app.project ? __getCurrentActiveSequence() : null;
          var activeSeq = activeSequence ? activeSequence.name : "None";
          return __result({
            connected: true,
            premiereVersion: version,
            projectName: projectName,
            activeSequence: activeSeq
          });
        `);
        return sendCommand(script, {
          ...bridgeOptions,
          timeoutMs: 5000,
          failFastOnUnreadyHeartbeat: true,
        });
      },
    },
    verify_premiere_connection: {
      description:
        "Run a safe, read-only first-run check. It proves that this MCP server, the selected Premiere bridge, an active project, and an active sequence are connected without returning project names, paths, or media details.",
      parameters: {
        type: "object" as const,
        properties: {
          backend: {
            type: "string",
            enum: ["cep", "uxp"],
            description: "Bridge to check. Defaults to CEP. This check never falls back to a different bridge.",
          },
        },
      },
      handler: async (args: { backend?: "cep" | "uxp" }) => {
        const backend = args.backend ?? "cep";
        const telemetry = options.telemetry ?? disabledTelemetry;

        let report: FirstRunReport;
        if (backend === "uxp") {
          if (!options.uxpBridge) {
            report = buildFirstRunReport("uxp", {
              reachable: false,
              uxpDiagnostic: { errorCode: "UXP_NOT_CONNECTED", connected: false, latest: null },
            });
          } else {
            try {
              // This is an explicit read-only UXP request. Do not try CEP if it
              // fails: even diagnostics should accurately name their backend.
              const result = await options.uxpBridge.request("state.get");
              const state = result && typeof result === "object"
                ? result as Record<string, unknown>
                : {};
              report = buildFirstRunReport("uxp", {
                reachable: true,
                projectOpen: state.projectOpen === true,
                sequenceOpen: state.sequenceOpen === true,
              });
            } catch (error) {
              report = buildFirstRunReport("uxp", {
                reachable: false,
                uxpDiagnostic: buildUxpDiagnostic(options.uxpBridge, error),
              });
            }
          }
        } else {
          try {
            const script = buildToolScript(`
              var projectOpen = !!(app && app.project && typeof app.project.name !== "undefined");
              var sequenceOpen = !!(projectOpen && __getCurrentActiveSequence());
              return __result({ projectOpen: projectOpen, sequenceOpen: sequenceOpen });
            `);
            const response = await sendCommand(script, {
              ...bridgeOptions,
              timeoutMs: 5000,
              failFastOnUnreadyHeartbeat: true,
            });
            const data = response.success && response.data && typeof response.data === "object"
              ? response.data as Record<string, unknown>
              : {};
            report = buildFirstRunReport("cep", {
              reachable: response.success === true,
              projectOpen: data.projectOpen === true,
              sequenceOpen: data.sequenceOpen === true,
            });
          } catch {
            report = buildFirstRunReport("cep", { reachable: false });
          }
        }

        // This is the only repository-owned activation signal. A tool call
        // that finds an unavailable bridge, project, or sequence remains a
        // useful diagnostic, but is not activation.
        if (report.overall === "ready") {
          captureActivationEvent(telemetry, { backend });
        }
        // A completed diagnostic remains a successful tool call even if it
        // identifies a problem. The structured report tells the user what to fix.
        return { success: true, data: report };
      },
    },
  };
}
