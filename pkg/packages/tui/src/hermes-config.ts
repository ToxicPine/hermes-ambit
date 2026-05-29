import type { HomeManagerPatch } from "@cardelli/shared";

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type HermesSettingsObject = { readonly [key: string]: JsonValue };

export type HermesReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const isHermesReasoningEffort = (
  value: string,
): value is HermesReasoningEffort =>
  value === "none" ||
  value === "minimal" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh";

export type AzureFoundryOpenAICompatibleApiMode =
  | "chat_completions"
  | "codex_responses";

export const isAzureFoundryOpenAICompatibleApiMode = (
  value: string,
): value is AzureFoundryOpenAICompatibleApiMode =>
  value === "chat_completions" || value === "codex_responses";

const commonHermesConfigSetKeys = [
  "model.default",
  "gateway.host",
  "gateway.port",
  "agent.max_turns",
  "agent.reasoning_effort",
] as const;

const azureHermesConfigSetKeys = [
  "model.api_mode",
] as const;

const hermesConfigSetKeys = [
  ...commonHermesConfigSetKeys,
  ...azureHermesConfigSetKeys,
] as const;

export type HermesConfigSetKey = (typeof hermesConfigSetKeys)[number];

const hermesConfigSetKeySet: ReadonlySet<string> = new Set(hermesConfigSetKeys);

export const hermesConfigSetKeysForProvider = (
  provider: "gcp" | "azure" | undefined,
): readonly HermesConfigSetKey[] =>
  provider === "azure"
    ? hermesConfigSetKeys
    : commonHermesConfigSetKeys;

export const isHermesConfigSetKey = (
  key: string,
): key is HermesConfigSetKey =>
  hermesConfigSetKeySet.has(key);

export type HermesGatewaySelection = {
  readonly host?: string;
  readonly port?: number;
};

export type HermesAgentSelection = {
  readonly maxTurns?: number;
  readonly reasoningEffort?: HermesReasoningEffort;
};

export type GcpGeminiDeveloperApiModelSelection = {
  readonly provider: "gcp";
  readonly model: string;
  readonly baseUrl?: string;
};

export type AzureFoundryOpenAICompatibleModelSelection = {
  readonly provider: "azure";
  readonly endpoint: string;
  readonly deploymentName: string;
  readonly apiMode?: AzureFoundryOpenAICompatibleApiMode;
};

export type HermesModelSelection =
  | GcpGeminiDeveloperApiModelSelection
  | AzureFoundryOpenAICompatibleModelSelection;

export type HermesConfigSelection = {
  readonly model: HermesModelSelection;
  readonly gateway?: HermesGatewaySelection;
  readonly agent?: HermesAgentSelection;
};

const DEFAULT_GEMINI_DEVELOPER_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
const AZURE_OPENAI_PATH = "/openai";
const AZURE_OPENAI_V1_PATH = "/openai/v1";

const indent = (level: number) => "  ".repeat(level);

const nixString = (value: string) => JSON.stringify(value);

const trimmedEndpoint = (endpoint: string): string =>
  endpoint.trim().replace(/\/+$/, "");

export const azureFoundryOpenAICompatibleBaseUrl = (
  endpoint: string,
): string => {
  const trimmed = trimmedEndpoint(endpoint);
  if (trimmed.endsWith(AZURE_OPENAI_V1_PATH)) {
    return trimmed;
  }
  if (trimmed.endsWith(AZURE_OPENAI_PATH)) {
    return `${trimmed}/v1`;
  }
  return `${trimmed}${AZURE_OPENAI_V1_PATH}`;
};

const renderNixValue = (value: JsonValue, level: number): string => {
  if (typeof value === "string") {
    return nixString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[ ${value.map((item) => renderNixValue(item, level)).join(" ")} ]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{ }";
  }

  const body = entries
    .map(
      ([key, entryValue]) =>
        `${indent(level + 1)}${key} = ${renderNixValue(entryValue, level + 1)};`,
    )
    .join("\n");
  return `{\n${body}\n${indent(level)}}`;
};

const isSettingsObject = (value: JsonValue): value is HermesSettingsObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const renderNixAssignments = (
  path: string,
  settings: HermesSettingsObject,
): string =>
  Object.entries(settings)
    .flatMap(([key, value]) => {
      const nextPath = `${path}.${key}`;
      return isSettingsObject(value)
        ? renderNixAssignments(nextPath, value).split("\n")
        : [`${nextPath} = ${renderNixValue(value, 1)};`];
    })
    .join("\n");

const renderForcedNixAssignments = (
  path: string,
  settings: HermesSettingsObject,
): string =>
  Object.entries(settings)
    .flatMap(([key, value]) => {
      const nextPath = `${path}.${key}`;
      return isSettingsObject(value)
        ? renderForcedNixAssignments(nextPath, value).split("\n")
        : [`${nextPath} = lib.mkForce ${renderNixValue(value, 1)};`];
    })
    .join("\n");

const modelSettings = (model: HermesModelSelection): HermesSettingsObject => {
  if (model.provider === "gcp") {
    return {
      default: model.model,
      provider: "gemini",
      base_url: model.baseUrl ?? DEFAULT_GEMINI_DEVELOPER_API_BASE_URL,
    };
  }

  return {
    default: model.deploymentName,
    provider: "azure-foundry",
    base_url: azureFoundryOpenAICompatibleBaseUrl(model.endpoint),
    api_mode: model.apiMode ?? "chat_completions",
  };
};

const gatewaySettings = (
  gateway: HermesGatewaySelection | undefined,
): HermesSettingsObject | undefined => {
  if (!gateway) return undefined;

  const settings = {
    ...(gateway.host ? { host: gateway.host } : {}),
    ...(gateway.port !== undefined ? { port: gateway.port } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
};

const agentSettings = (
  agent: HermesAgentSelection | undefined,
): HermesSettingsObject | undefined => {
  if (!agent) return undefined;

  const settings = {
    ...(agent.maxTurns !== undefined ? { max_turns: agent.maxTurns } : {}),
    ...(agent.reasoningEffort
      ? { reasoning_effort: agent.reasoningEffort }
      : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
};

const selectionToHermesSettings = (
  selection: HermesConfigSelection,
): HermesSettingsObject => {
  const gateway = gatewaySettings(selection.gateway);
  const agent = agentSettings(selection.agent);

  return {
    model: modelSettings(selection.model),
    ...(gateway ? { gateway } : {}),
    ...(agent ? { agent } : {}),
  };
};

export const renderHermesPatch = (
  selection: HermesConfigSelection,
): HomeManagerPatch => ({
  block: renderForcedNixAssignments(
    "programs.hermes-agent.settings",
    selectionToHermesSettings(selection),
  ),
});

export const renderHermesModelPatch = (
  model: HermesModelSelection,
): HomeManagerPatch => ({
  section: "model",
  block: renderForcedNixAssignments(
    "programs.hermes-agent.settings.model",
    modelSettings(model),
  ),
});

export const renderHermesSettingPatch = (
  key: HermesConfigSetKey,
  value: string | number,
): HomeManagerPatch => ({
  section: key,
  block: `programs.hermes-agent.settings.${key} = lib.mkForce ${renderNixValue(value, 1)};`,
});
