import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  AppError,
  CommandIntent,
  GlobalOptions,
  ProviderKind,
} from "./types.js";

const providerKindSchema = z.enum(["gcp", "azure"]);

const gcpConfigSchema = z
  .object({
    project: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    serviceAccount: z.string().min(1).optional(),
    quotaProject: z.string().min(1).optional(),
    state: z.literal("nfs").optional(),
    stateServer: z.string().min(1).optional(),
    statePath: z.string().min(1).optional(),
    stateDataPath: z.string().min(1).optional(),
    stateNixPath: z.string().min(1).optional(),
  })
  .strict();

const azureConfigSchema = z
  .object({
    subscription: z.string().min(1).optional(),
    tenant: z.string().min(1).optional(),
    resourceGroup: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    storageName: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    state: z.literal("azure-files").optional(),
    stateDataPath: z.string().min(1).optional(),
    stateNixPath: z.string().min(1).optional(),
  })
  .strict();

const deployerConfigSchema = z
  .object({
    profile: z.string().min(1).optional(),
    provider: providerKindSchema.optional(),
    deployment: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    gcp: gcpConfigSchema.optional(),
    azure: azureConfigSchema.optional(),
  })
  .strict()
  .refine(
    (config) => config.provider !== "gcp" || config.azure === undefined,
    "GCP config cannot include an azure section.",
  )
  .refine(
    (config) => config.provider !== "azure" || config.gcp === undefined,
    "Azure config cannot include a gcp section.",
  );

type DeployerConfig = z.infer<typeof deployerConfigSchema>;

const configReadFailed = (path: string): AppError => ({
  code: "config.readFailed",
  message: `Could not read config file ${path}.`,
});

const configInvalid = (path: string): AppError => ({
  code: "config.invalid",
  message: `Config file ${path} is not a valid Hermes Ambit deployer config.`,
});

const parseConfigText = (path: string, text: string): unknown => {
  const extension = extname(path).toLowerCase();
  return extension === ".json" ? JSON.parse(text) : parseYaml(text);
};

export const readDeployerConfig = (
  path: string,
): DeployerConfig | AppError => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return configReadFailed(path);
  }

  let value: unknown;
  try {
    value = parseConfigText(path, text);
  } catch {
    return configInvalid(path);
  }

  const parsed = deployerConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : configInvalid(path);
};

const providerFromConfig = (
  config: DeployerConfig,
): ProviderKind | undefined => {
  if (config.provider) return config.provider;
  if (config.gcp && !config.azure) return "gcp";
  if (config.azure && !config.gcp) return "azure";
  return undefined;
};

const configProviderMismatch = (message: string): AppError => ({
  code: "config.invalid",
  message,
});

const providerForMergedConfig = (
  globals: GlobalOptions,
  config: DeployerConfig,
): ProviderKind | AppError | undefined => {
  const configProvider = providerFromConfig(config);
  if (
    globals.provider &&
    config.provider &&
    globals.provider !== config.provider
  ) {
    return configProviderMismatch(
      `Config provider ${config.provider} does not match --provider ${globals.provider}.`,
    );
  }

  const provider = globals.provider ?? configProvider;
  if (!provider && config.gcp && config.azure) {
    return configProviderMismatch(
      "Config file cannot include both gcp and azure sections without selecting a provider.",
    );
  }
  if (provider === "gcp" && config.azure) {
    return configProviderMismatch(
      "Config file azure section cannot be used with provider gcp.",
    );
  }
  if (provider === "azure" && config.gcp) {
    return configProviderMismatch(
      "Config file gcp section cannot be used with provider azure.",
    );
  }

  return provider;
};

const putMappedFields = <TConfig extends Readonly<Record<string, unknown>>>(
  fields: Record<string, string>,
  config: TConfig,
  entries: readonly (readonly [keyof TConfig, string])[],
): void => {
  for (const [configKey, field] of entries) {
    const value = config[configKey];
    if (typeof value === "string") {
      fields[field] = value;
    }
  }
};

const gcpConfigFields = [
  ["project", "project"],
  ["region", "region"],
  ["serviceAccount", "service-account"],
  ["quotaProject", "quota-project"],
  ["state", "state"],
  ["stateServer", "state-server"],
  ["statePath", "state-path"],
  ["stateDataPath", "state-data-path"],
  ["stateNixPath", "state-nix-path"],
] as const satisfies readonly (readonly [
  keyof NonNullable<DeployerConfig["gcp"]>,
  string,
])[];

const azureConfigFields = [
  ["subscription", "subscription"],
  ["tenant", "tenant"],
  ["resourceGroup", "resource-group"],
  ["location", "location"],
  ["environmentId", "environment-id"],
  ["storageName", "storage-name"],
  ["endpoint", "endpoint"],
  ["state", "state"],
  ["stateDataPath", "state-data-path"],
  ["stateNixPath", "state-nix-path"],
] as const satisfies readonly (readonly [
  keyof NonNullable<DeployerConfig["azure"]>,
  string,
])[];

const gcpProviderFieldsFromConfig = (
  config: NonNullable<DeployerConfig["gcp"]>,
): Readonly<Record<string, string>> => {
  const fields: Record<string, string> = {};
  putMappedFields(fields, config, gcpConfigFields);
  return fields;
};

const azureProviderFieldsFromConfig = (
  config: NonNullable<DeployerConfig["azure"]>,
): Readonly<Record<string, string>> => {
  const fields: Record<string, string> = {};
  putMappedFields(fields, config, azureConfigFields);
  return fields;
};

const providerFieldsFromConfig = (
  config: DeployerConfig,
  provider: ProviderKind | undefined,
): Readonly<Record<string, string>> => ({
  ...(config.user ? { user: config.user } : {}),
  ...(provider === "gcp" && config.gcp
    ? gcpProviderFieldsFromConfig(config.gcp)
    : {}),
  ...(provider === "azure" && config.azure
    ? azureProviderFieldsFromConfig(config.azure)
    : {}),
});

const mergeGlobals = (
  globals: GlobalOptions,
  config: DeployerConfig,
): GlobalOptions | AppError => {
  const { config: _consumedConfig, ...baseGlobals } = globals;
  const provider = providerForMergedConfig(globals, config);
  if (provider && typeof provider !== "string") return provider;

  return {
    ...baseGlobals,
    ...(globals.profile ? {} : config.profile ? { profile: config.profile } : {}),
    ...(provider ? { provider } : {}),
    ...(globals.deployment
      ? {}
      : config.deployment
        ? { deployment: config.deployment }
        : {}),
    providerFields: {
      ...providerFieldsFromConfig(config, provider),
      ...globals.providerFields,
    },
  };
};

export const mergeConfigIntoIntent = (
  intent: CommandIntent,
  config: DeployerConfig,
): CommandIntent | AppError => {
  const globals = mergeGlobals(intent.globals, config);
  return "code" in globals
    ? globals
    : {
        ...intent,
        globals,
      };
};
