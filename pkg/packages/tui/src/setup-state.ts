import type { AppError, ProviderKind } from "./types.js";
import type { AppProfile } from "./app-profile.js";
import { validateDeploymentName, validateProfileName } from "./app-profile.js";

export type SetupDraft = {
  readonly profileName: string;
  readonly provider?: ProviderKind;
  readonly deployment?: string;
  readonly user: string;
  readonly fields: Readonly<Record<string, string>>;
};

export type SetupArgs = {
  readonly profile?: string;
  readonly provider?: ProviderKind;
  readonly deployment?: string;
  readonly fields?: Readonly<Record<string, string>>;
};

type SetupDraftField = {
  readonly key: string;
  readonly label: string;
  readonly value?: string;
  readonly required: boolean;
};

type ProviderFieldShape = {
  readonly providers: readonly ProviderKind[];
  readonly values?: Partial<Record<ProviderKind, readonly string[]>>;
};

const providerFieldShapes: Readonly<Record<string, ProviderFieldShape>> = {
  project: { providers: ["gcp"] },
  region: { providers: ["gcp"] },
  "service-account": { providers: ["gcp"] },
  "quota-project": { providers: ["gcp"] },
  model: { providers: ["gcp", "azure"] },
  "state-server": { providers: ["gcp"] },
  "state-path": { providers: ["gcp"] },
  subscription: { providers: ["azure"] },
  tenant: { providers: ["azure"] },
  "resource-group": { providers: ["azure"] },
  location: { providers: ["azure"] },
  "environment-id": { providers: ["azure"] },
  "storage-name": { providers: ["azure"] },
  endpoint: { providers: ["azure"] },
  state: {
    providers: ["gcp", "azure"],
    values: {
      gcp: ["nfs"],
      azure: ["azure-files"],
    },
  },
  "state-data-path": { providers: ["gcp", "azure"] },
  "state-nix-path": { providers: ["gcp", "azure"] },
  user: { providers: ["gcp", "azure"] },
};

export const isProviderField = (field: string): boolean =>
  providerFieldShapes[field] !== undefined;

export const providerFieldProviders = (
  field: string,
): readonly ProviderKind[] | undefined => providerFieldShapes[field]?.providers;

export const invalidProviderFields = (
  provider: ProviderKind,
  fields: Readonly<Record<string, string>>,
): readonly string[] => {
  return Object.keys(fields).filter((field) => {
    const providers = providerFieldProviders(field);
    return providers !== undefined && !providers.includes(provider);
  });
};

export const providerFieldAllowedValues = (
  provider: ProviderKind,
  field: string,
): readonly string[] | undefined =>
  providerFieldShapes[field]?.values?.[provider];

export const invalidProviderFieldValues = (
  provider: ProviderKind,
  fields: Readonly<Record<string, string>>,
): readonly string[] =>
  Object.entries(fields)
    .filter(([field, value]) => {
      const values = providerFieldAllowedValues(provider, field);
      return values !== undefined && !values.includes(value);
    })
    .map(([field]) => field);

const withoutFields = (
  fields: Readonly<Record<string, string>>,
  keys: readonly string[],
): Readonly<Record<string, string>> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!keys.includes(key)) {
      next[key] = value;
    }
  }
  return next;
};

const stateBaseChildPath = (
  basePath: string,
  child: "data" | "nix",
): string => {
  const base = basePath.replace(/\/+$/, "");
  return base.length === 0 ? `/${child}` : `${base}/${child}`;
};

export const gcpStateDataPath = (
  fields: Readonly<Record<string, string>>,
): string | undefined =>
  fields["state-data-path"] ??
  (fields["state-path"]
    ? stateBaseChildPath(fields["state-path"], "data")
    : undefined);

export const gcpStateNixPath = (
  fields: Readonly<Record<string, string>>,
): string | undefined =>
  fields["state-nix-path"] ??
  (fields["state-path"]
    ? stateBaseChildPath(fields["state-path"], "nix")
    : undefined);

export const azureStateDataSubPath = (
  fields: Readonly<Record<string, string>>,
): string => fields["state-data-path"] ?? "data";

export const azureStateNixSubPath = (
  fields: Readonly<Record<string, string>>,
): string => fields["state-nix-path"] ?? "nix";

export const missingGcpStatePathFields = (
  fields: Readonly<Record<string, string>>,
): readonly string[] => {
  if (fields["state-path"]) return [];

  const missing = [
    ...(fields["state-data-path"] ? [] : ["state-data-path"]),
    ...(fields["state-nix-path"] ? [] : ["state-nix-path"]),
  ];
  return missing.length === 2 ? ["state-path"] : missing;
};

const invalidProviderFieldError = (
  provider: ProviderKind,
  field: string,
): AppError => ({
  code: "args.invalid",
  message: `--${field} is not valid for provider ${provider}.`,
});

const invalidProviderFieldValueError = (
  provider: ProviderKind,
  field: string,
): AppError => ({
  code: "args.invalid",
  message: `--${field} for provider ${provider} must be ${providerFieldAllowedValues(provider, field)?.join(" or ")}.`,
});

const makeDraft = (
  profileName: string,
  provider: ProviderKind | undefined,
  deployment: string | undefined,
  user: string,
  fields: Readonly<Record<string, string>>,
): SetupDraft => ({
  profileName,
  ...(provider ? { provider } : {}),
  ...(deployment ? { deployment } : {}),
  user,
  fields: withoutFields(fields, ["user"]),
});

export const draftFromArgs = (args: SetupArgs): SetupDraft =>
  makeDraft(
    args.profile ?? "default",
    args.provider,
    args.deployment,
    args.fields?.["user"] ?? "user",
    args.fields ?? {},
  );

export const draftFromProfile = (profile: AppProfile): SetupDraft => ({
  profileName: profile.name,
  provider: profile.provider,
  deployment: profile.deployment,
  user: profile.user,
  fields:
    profile.provider === "gcp"
      ? {
          project: profile.gcp.projectId,
          region: profile.gcp.region,
          ...(profile.gcp.serviceAccount
            ? { "service-account": profile.gcp.serviceAccount }
            : {}),
          ...(profile.quotaProjectId
            ? { "quota-project": profile.quotaProjectId }
            : {}),
          model: profile.gcp.model,
          state: "nfs",
          "state-server": profile.gcp.state.server,
          "state-data-path": profile.gcp.state.dataPath,
          "state-nix-path": profile.gcp.state.nixPath,
        }
      : {
          subscription: profile.azure.subscriptionId,
          tenant: profile.tenantId,
          "resource-group": profile.azure.resourceGroupName,
          location: profile.azure.location,
          "environment-id": profile.azure.environmentId,
          endpoint: profile.azure.openaiCompatibleEndpoint,
          model: profile.azure.modelDeployment,
          state: "azure-files",
          "storage-name": profile.azure.state.storageName,
          "state-data-path": profile.azure.state.dataSubPath,
          "state-nix-path": profile.azure.state.nixSubPath,
        },
});

export const validateDraft = (draft: SetupDraft): readonly AppError[] => {
  const errors: AppError[] = [];
  const profileError = validateProfileName(draft.profileName);
  if (profileError) {
    errors.push(profileError);
  }
  if (!draft.provider) {
    errors.push({
      code: "args.missing",
      message:
        "Missing required provider. Use --provider gcp or --provider azure.",
    });
  }
  if (!draft.deployment) {
    errors.push({
      code: "args.missing",
      message: "Missing required deployment identity. Use --deployment <name>.",
    });
  } else {
    const deploymentError = validateDeploymentName(draft.deployment);
    if (deploymentError) {
      errors.push(deploymentError);
    }
  }
  if (draft.user.trim().length === 0) {
    errors.push({
      code: "args.missing",
      message: "Missing required container user. Use --user <name>.",
    });
  }
  const provider = draft.provider;
  if (provider) {
    errors.push(
      ...invalidProviderFields(provider, draft.fields).map((field) =>
        invalidProviderFieldError(provider, field),
      ),
      ...invalidProviderFieldValues(provider, draft.fields).map((field) =>
        invalidProviderFieldValueError(provider, field),
      ),
    );
  }
  if (draft.provider === "gcp") {
    for (const field of ["project", "region", "model", "state-server"]) {
      if (!draft.fields[field]) {
        errors.push({
          code: "args.missing",
          message: `Missing required GCP field. Use --${field} <value>.`,
        });
      }
    }
    if (missingGcpStatePathFields(draft.fields).length > 0) {
      errors.push({
        code: "args.missing",
        message:
          "Missing required GCP state paths. Use --state-path <base-path> or both --state-data-path <path> and --state-nix-path <path>.",
      });
    }
  }
  if (draft.provider === "azure") {
    for (const field of [
      "subscription",
      "tenant",
      "resource-group",
      "location",
      "environment-id",
      "storage-name",
      "endpoint",
      "model",
    ]) {
      if (!draft.fields[field]) {
        errors.push({
          code: "args.missing",
          message: `Missing required Azure field. Use --${field} <value>.`,
        });
      }
    }
  }
  return errors;
};

const draftValue = (draft: SetupDraft, key: string): string | undefined => {
  if (key === "profile") return draft.profileName;
  if (key === "provider") return draft.provider;
  if (key === "deployment") return draft.deployment;
  if (key === "user") return draft.user;
  return draft.fields[key];
};

const draftField = (
  draft: SetupDraft,
  key: string,
  label: string,
  required: boolean,
): SetupDraftField => {
  const value = draftValue(draft, key);
  return {
    key,
    label,
    required,
    ...(value ? { value } : {}),
  };
};

const commonDraftFields = (draft: SetupDraft): readonly SetupDraftField[] => [
  draftField(draft, "profile", "Profile", true),
  draftField(draft, "provider", "Provider", true),
  draftField(draft, "deployment", "Deployment", true),
  draftField(draft, "user", "Container user", true),
];

const gcpDraftFields = (draft: SetupDraft): readonly SetupDraftField[] => {
  const sharedStatePath = draft.fields["state-path"];
  return [
    ...commonDraftFields(draft),
    draftField(draft, "project", "GCP project", true),
    draftField(draft, "region", "GCP region", true),
    draftField(draft, "service-account", "Cloud Run service account", false),
    draftField(draft, "quota-project", "Quota project", false),
    draftField(draft, "model", "Gemini model", true),
    draftField(draft, "state-server", "NFS server", true),
    ...(sharedStatePath
      ? [draftField(draft, "state-path", "NFS state base path", true)]
      : [
          draftField(draft, "state-data-path", "NFS data path", true),
          draftField(draft, "state-nix-path", "NFS Nix path", true),
        ]),
  ];
};

const azureDraftFields = (draft: SetupDraft): readonly SetupDraftField[] => [
  ...commonDraftFields(draft),
  draftField(draft, "tenant", "Azure tenant", true),
  draftField(draft, "subscription", "Azure subscription", true),
  draftField(draft, "resource-group", "Azure resource group", true),
  draftField(draft, "location", "Azure location", true),
  draftField(draft, "environment-id", "Container Apps environment", true),
  draftField(draft, "storage-name", "Environment storage", true),
  draftField(draft, "endpoint", "Foundry OpenAI-compatible endpoint", true),
  draftField(draft, "model", "Foundry deployment name", true),
  draftField(draft, "state-data-path", "State data subpath", false),
  draftField(draft, "state-nix-path", "State Nix subpath", false),
];

export const setupDraftFields = (
  draft: SetupDraft,
): readonly SetupDraftField[] => {
  if (draft.provider === "gcp") return gcpDraftFields(draft);
  if (draft.provider === "azure") return azureDraftFields(draft);
  return commonDraftFields(draft);
};

export const setupDraftMissingFields = (
  draft: SetupDraft,
): readonly SetupDraftField[] =>
  setupDraftFields(draft).filter(
    (field) => field.required && field.value === undefined,
  );

const putField = (
  fields: Readonly<Record<string, string>>,
  key: string,
  value: string,
  removeKeys: readonly string[] = [],
): Readonly<Record<string, string>> => {
  const next: Record<string, string> = {};
  const blocked = [key, ...removeKeys];
  for (const [fieldKey, fieldValue] of Object.entries(fields)) {
    if (!blocked.includes(fieldKey)) {
      next[fieldKey] = fieldValue;
    }
  }
  if (value.length > 0) {
    next[key] = value;
  }
  return next;
};

export const setSetupDraftField = (
  draft: SetupDraft,
  key: string,
  rawValue: string,
): SetupDraft => {
  const value = rawValue.trim();
  if (key === "profile") {
    return makeDraft(
      value,
      draft.provider,
      draft.deployment,
      draft.user,
      draft.fields,
    );
  }
  if (key === "provider") {
    const provider = value === "gcp" || value === "azure" ? value : undefined;
    const fields = provider === draft.provider ? draft.fields : {};
    return makeDraft(
      draft.profileName,
      provider,
      draft.deployment,
      draft.user.trim().length > 0 ? draft.user : "user",
      fields,
    );
  }
  if (key === "deployment") {
    return makeDraft(
      draft.profileName,
      draft.provider,
      value.length > 0 ? value : undefined,
      draft.user,
      draft.fields,
    );
  }
  if (key === "user") {
    return makeDraft(
      draft.profileName,
      draft.provider,
      draft.deployment,
      value,
      draft.fields,
    );
  }
  if (key === "state-path") {
    return makeDraft(
      draft.profileName,
      draft.provider,
      draft.deployment,
      draft.user,
      putField(draft.fields, key, value, ["state-data-path", "state-nix-path"]),
    );
  }
  if (key === "state-data-path" || key === "state-nix-path") {
    return makeDraft(
      draft.profileName,
      draft.provider,
      draft.deployment,
      draft.user,
      putField(draft.fields, key, value, ["state-path"]),
    );
  }
  return makeDraft(
    draft.profileName,
    draft.provider,
    draft.deployment,
    draft.user,
    value.length > 0
      ? putField(draft.fields, key, value)
      : withoutFields(draft.fields, [key]),
  );
};

export const profileFromDraft = (draft: SetupDraft): AppProfile | undefined => {
  if (validateDraft(draft).length > 0 || !draft.provider || !draft.deployment) {
    return undefined;
  }

  if (draft.provider === "gcp") {
    const projectId = draft.fields["project"];
    const region = draft.fields["region"];
    const stateServer = draft.fields["state-server"];
    const dataPath = gcpStateDataPath(draft.fields);
    const nixPath = gcpStateNixPath(draft.fields);
    const model = draft.fields["model"];
    if (
      !projectId ||
      !region ||
      !model ||
      !stateServer ||
      !dataPath ||
      !nixPath
    ) {
      return undefined;
    }

    return {
      provider: "gcp",
      name: draft.profileName,
      deployment: draft.deployment,
      user: draft.user,
      ...(draft.fields["quota-project"]
        ? { quotaProjectId: draft.fields["quota-project"] }
        : {}),
      gcp: {
        projectId,
        region,
        ...(draft.fields["service-account"]
          ? { serviceAccount: draft.fields["service-account"] }
          : {}),
        model,
        state: {
          server: stateServer,
          dataPath,
          nixPath,
        },
      },
    };
  }

  const tenantId = draft.fields["tenant"];
  const subscriptionId = draft.fields["subscription"];
  const resourceGroupName = draft.fields["resource-group"];
  const location = draft.fields["location"];
  const environmentId = draft.fields["environment-id"];
  const storageName = draft.fields["storage-name"];
  const endpoint = draft.fields["endpoint"];
  const model = draft.fields["model"];
  if (
    !tenantId ||
    !subscriptionId ||
    !resourceGroupName ||
    !location ||
    !environmentId ||
    !storageName ||
    !endpoint ||
    !model
  ) {
    return undefined;
  }

  return {
    provider: "azure",
    name: draft.profileName,
    deployment: draft.deployment,
    user: draft.user,
    tenantId,
    azure: {
      subscriptionId,
      resourceGroupName,
      location,
      environmentId,
      openaiCompatibleEndpoint: endpoint,
      modelDeployment: model,
      state: {
        storageName,
        dataSubPath: azureStateDataSubPath(draft.fields),
        nixSubPath: azureStateNixSubPath(draft.fields),
      },
    },
  };
};
