import type { CloudEvent, Remediation } from "@cardelli/shared";

import type {
  AppError,
  CommandName,
  CommandResult,
  ResultContext,
} from "./types.js";

type JsonEnvelope =
  | (ResultContext & {
      readonly ok: true;
      readonly command: CommandName;
      readonly summary: string;
      readonly data?: unknown;
      readonly debug?: unknown;
      readonly diagnostics: readonly CloudEvent[];
      readonly remediations: readonly Remediation[];
    })
  | (ResultContext & {
      readonly ok: false;
      readonly command: CommandName;
      readonly error: AppError;
      readonly diagnostics: readonly CloudEvent[];
      readonly remediations: readonly Remediation[];
    });

const contextFields = (result: CommandResult): ResultContext => ({
  ...(result.profile ? { profile: result.profile } : {}),
  ...(result.provider ? { provider: result.provider } : {}),
  ...(result.deployment ? { deployment: result.deployment } : {}),
});

const jsonEnvelope = (result: CommandResult): JsonEnvelope =>
  result.ok
    ? {
        ok: true,
        command: result.command,
        ...contextFields(result),
        summary: result.summary,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.debug !== undefined ? { debug: result.debug } : {}),
        diagnostics: result.diagnostics ?? [],
        remediations: [],
      }
    : {
        ok: false,
        command: result.command,
        ...contextFields(result),
        error: result.error,
        diagnostics: result.diagnostics ?? [],
        remediations: result.remediations ?? [],
      };

export const renderJson = (result: CommandResult): string =>
  `${JSON.stringify(jsonEnvelope(result), null, 2)}\n`;

const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const field = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;

const stringField = (value: unknown, name: string): string | undefined => {
  const entry = field(value, name);
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
};

const booleanField = (value: unknown, name: string): boolean | undefined => {
  const entry = field(value, name);
  return typeof entry === "boolean" ? entry : undefined;
};

const numberField = (value: unknown, name: string): number | undefined => {
  const entry = field(value, name);
  return typeof entry === "number" ? entry : undefined;
};

const arrayItems = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const renderDetailLine = (label: string, value: string): string =>
  `  ${label}: ${value}`;

const renderOptionalDetailLine = (
  label: string,
  value: string | undefined,
): readonly string[] => (value ? [renderDetailLine(label, value)] : []);

const renderStatusDetails = (data: unknown): string => {
  const runtime = field(data, "runtime") ?? data;
  const config = field(data, "config");
  const reconciling = booleanField(runtime, "reconciling");
  const configured = booleanField(config, "configured");
  const lines = [
    ...renderOptionalDetailLine("endpoint", stringField(runtime, "endpoint")),
    ...renderOptionalDetailLine("image", stringField(runtime, "image")),
    ...renderOptionalDetailLine(
      "latest ready revision",
      stringField(runtime, "latestReadyRevision"),
    ),
    ...renderOptionalDetailLine(
      "latest created revision",
      stringField(runtime, "latestCreatedRevision"),
    ),
    ...renderOptionalDetailLine(
      "latest revision",
      stringField(runtime, "latestRevision"),
    ),
    ...renderOptionalDetailLine(
      "running status",
      stringField(runtime, "runningStatus"),
    ),
    ...renderOptionalDetailLine(
      "provisioning state",
      stringField(runtime, "provisioningState"),
    ),
    ...(reconciling !== undefined
      ? [renderDetailLine("reconciling", String(reconciling))]
      : []),
    ...(configured !== undefined
      ? [renderDetailLine("managed config", configured ? "present" : "absent")]
      : []),
    ...renderOptionalDetailLine(
      "managed config hash",
      stringField(config, "managedModuleHash"),
    ),
  ];

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
};

const renderSetupBoundary = (
  provider: string | undefined,
  data: unknown,
): string | undefined => {
  if (provider === "gcp") {
    const gcp = field(data, "gcp");
    const project = stringField(gcp, "projectId");
    const region = stringField(gcp, "region");
    return project && region
      ? `project ${project}, region ${region}`
      : undefined;
  }

  if (provider === "azure") {
    const azure = field(data, "azure");
    const subscription = stringField(azure, "subscriptionId");
    const resourceGroup = stringField(azure, "resourceGroupName");
    const location = stringField(azure, "location");
    return subscription && resourceGroup && location
      ? `subscription ${subscription}, resource group ${resourceGroup}, location ${location}`
      : undefined;
  }

  return undefined;
};

const renderSetupDetails = (data: unknown): string => {
  const profile = stringField(data, "name");
  const provider = stringField(data, "provider");
  const deployment = stringField(data, "deployment");
  const boundary = renderSetupBoundary(provider, data);
  const lines = [
    ...renderOptionalDetailLine("profile", profile),
    ...renderOptionalDetailLine("provider", provider),
    ...renderOptionalDetailLine("deployment", deployment),
    ...renderOptionalDetailLine("user", stringField(data, "user")),
    ...renderOptionalDetailLine("boundary", boundary),
    ...(profile
      ? [renderDetailLine("next", `hermes-ambit deploy --profile ${profile}`)]
      : []),
  ];

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
};

const renderAuthDetails = (data: unknown): string => {
  const expiresAtEpochSeconds = numberField(data, "expiresAtEpochSeconds");
  const boundaryChecked = booleanField(data, "boundaryChecked");
  const lines = [
    ...renderOptionalDetailLine(
      "quota project",
      stringField(data, "quotaProjectId"),
    ),
    ...renderOptionalDetailLine("tenant", stringField(data, "tenantId")),
    ...renderOptionalDetailLine(
      "subscription",
      stringField(data, "subscriptionId"),
    ),
    ...(expiresAtEpochSeconds !== undefined
      ? [
          renderDetailLine(
            "token expires",
            new Date(expiresAtEpochSeconds * 1000).toISOString(),
          ),
        ]
      : []),
    ...(boundaryChecked !== undefined
      ? [renderDetailLine("boundary checked", String(boundaryChecked))]
      : []),
  ];

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
};

const renderConfigDetails = (data: unknown): string => {
  const configured = booleanField(data, "configured");
  const managedModule = stringField(data, "managedModule");
  const lines = [
    ...(configured !== undefined
      ? [renderDetailLine("configured", String(configured))]
      : []),
    ...renderOptionalDetailLine(
      "managed config hash",
      stringField(data, "managedModuleHash"),
    ),
  ];
  const details = lines.length > 0 ? `\n${lines.join("\n")}` : "";
  return managedModule ? `${details}\n\n${managedModule}` : details;
};

const renderDiscoverDetails = (data: unknown): string => {
  const deployments = arrayItems(field(data, "deployments"));
  if (deployments.length === 0) return "";

  return `\n${deployments
    .map((deployment) => {
      const kind = stringField(deployment, "resourceKind");
      const name = stringField(deployment, "resourceName");
      const endpoint = stringField(deployment, "endpoint");
      const heading = [kind, name].filter(Boolean).join(" ");
      return endpoint ? `  - ${heading} (${endpoint})` : `  - ${heading}`;
    })
    .join("\n")}`;
};

const renderModelsDetails = (data: unknown): string => {
  const models = arrayItems(data);
  if (models.length === 0) return "";

  return `\n${models
    .map((model) => {
      const id = stringField(model, "id") ?? "unknown";
      const route = stringField(model, "route");
      const runtimeTarget = stringField(model, "runtimeTarget");
      const targetDetail =
        runtimeTarget === "deployment-name"
          ? "configure deployment name"
          : runtimeTarget === "model-id"
            ? "use model id"
            : "";
      const suffix = [route, targetDetail].filter(Boolean).join("; ");
      return suffix ? `  - ${id} (${suffix})` : `  - ${id}`;
    })
    .join("\n")}`;
};

const renderSecretsDetails = (data: unknown): string => {
  const secrets = arrayItems(data);
  if (secrets.length === 0) return "";

  return `\n${secrets
    .map((secret) =>
      `  - ${
        typeof secret === "string"
          ? secret
          : stringField(secret, "name") ?? "unknown"
      }`
    )
    .join("\n")}`;
};

const renderDoctorDetails = (data: unknown): string => {
  const checks = arrayItems(field(data, "checks"));
  if (checks.length === 0) return "";

  return `\n${checks
    .map((check) => {
      const status = stringField(check, "status") ?? "unknown";
      const name = stringField(check, "name") ?? "check";
      const message = stringField(check, "message");
      return message
        ? `  - ${status} ${name}: ${message}`
        : `  - ${status} ${name}`;
    })
    .join("\n")}`;
};

const renderDebug = (
  result: Extract<CommandResult, { readonly ok: true }>,
): string =>
  result.debug === undefined
    ? ""
    : `\nDebug:\n${JSON.stringify(result.debug, null, 2)}`;

const renderSuccessDetails = (
  result: Extract<CommandResult, { readonly ok: true }>,
): string => {
  if (result.command === "auth.check" && result.data !== undefined) {
    return renderAuthDetails(result.data);
  }
  if (result.command === "setup" && result.data !== undefined) {
    return renderSetupDetails(result.data);
  }
  if (result.command === "status" && result.data !== undefined) {
    return renderStatusDetails(result.data);
  }
  if (result.command === "config.show" && result.data !== undefined) {
    return renderConfigDetails(result.data);
  }
  if (result.command === "discover" && result.data !== undefined) {
    return renderDiscoverDetails(result.data);
  }
  if (result.command === "models.list" && result.data !== undefined) {
    return renderModelsDetails(result.data);
  }
  if (result.command === "secrets.list" && result.data !== undefined) {
    return renderSecretsDetails(result.data);
  }
  if (result.command === "doctor" && result.data !== undefined) {
    return renderDoctorDetails(result.data);
  }
  return "";
};

const renderRemediations = (result: Extract<CommandResult, { ok: false }>) =>
  result.remediations && result.remediations.length > 0
    ? `\nRemediation:\n${result.remediations
        .map((remediation) => `  - ${remediation.label}: ${remediation.url}`)
        .join("\n")}`
    : "";

export const renderHuman = (result: CommandResult): string => {
  if (result.ok) {
    return `${result.summary}${renderSuccessDetails(result)}${renderDebug(result)}\n`;
  }

  return `Error: ${result.error.message}\nCode: ${
    result.error.code
  }${renderRemediations(result)}\n`;
};
