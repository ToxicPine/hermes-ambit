import {
  CloudLog,
  HERMES_DATA_MOUNT_PATH,
  HERMES_NIX_MOUNT_PATH,
  RUNTIME_SECRET_NAME_MESSAGE,
  isRuntimeSecretName,
  isUniversalHermesImageConfigured,
  type CloudError,
  type CloudEvent,
  type HomeManagerPatch,
  type Remediation,
} from "@cardelli/shared";
import { Effect, Either } from "effect";

import type { AppProfile } from "./app-profile.js";
import { validateProfileName } from "./app-profile.js";
import type {
  AppError,
  CommandIntent,
  CommandResult,
  ExecutableCommandIntent,
  ResultContext,
  SecretInputSource,
} from "./types.js";
import { commandMustNotPrompt } from "./types.js";
import type { ProfileStore } from "./profile-store.js";
import {
  authTargetFromProfile,
  discoveryTargetFromProfile,
  makeDefaultProviderAuthRunner,
  makeDefaultProviderDiscoveryRunner,
  makeDefaultProviderModelRunner,
  makeDefaultProviderRunner,
  missingAzureModelEndpoint,
  modelTargetFromProfile,
  targetFromProfile,
  type LocalCredentialRequest,
  type ProviderAuthTarget,
  type ProviderAuthRunner,
  type ProviderAuthRunnerFactory,
  type ProviderDiscoveryTarget,
  type ProviderDiscoveryRunner,
  type ProviderDiscoveryRunnerFactory,
  type ProviderModelTarget,
  type ProviderModelRunner,
  type ProviderModelRunnerFactory,
  type ProviderTarget,
  type ProviderRunner,
  type ProviderRunnerFactory,
  type ProviderOperationResult,
} from "./profile-runner.js";
import {
  isHermesConfigSetKey,
  isAzureFoundryOpenAICompatibleApiMode,
  isHermesReasoningEffort,
  renderHermesModelPatch,
  renderHermesSettingPatch,
  type HermesConfigSetKey,
} from "./hermes-config.js";
import {
  azureStateDataSubPath,
  azureStateNixSubPath,
  draftFromArgs,
  draftFromProfile,
  gcpStateDataPath,
  gcpStateNixPath,
  invalidProviderFieldValues,
  invalidProviderFields,
  missingGcpStatePathFields,
  providerFieldAllowedValues,
  profileFromDraft,
  validateDraft,
  type SetupArgs,
  type SetupDraft,
} from "./setup-state.js";
import type {
  ProviderConfigRead,
  ProviderDeployPreviewSummary,
  ProviderConfigSummary,
  ProviderStatusSummary,
} from "./provider-summary.js";
import {
  azureIdentityCredentialsRemediation,
  gcpApplicationDefaultCredentialsRemediation,
} from "./auth.js";

export type RuntimeInfo = {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
};

export type CommandRuntime = {
  readonly runtimeInfo?: RuntimeInfo;
  readonly profiles?: ProfileStore;
  readonly authRunners?: ProviderAuthRunnerFactory;
  readonly discoveryRunners?: ProviderDiscoveryRunnerFactory;
  readonly modelRunners?: ProviderModelRunnerFactory;
  readonly runners?: ProviderRunnerFactory;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly promptText?: (
    label: string,
    defaultValue?: string,
  ) => Promise<string>;
  readonly deviceCodePrompt?: (message: string) => void;
  readonly readStdin?: () => Promise<string>;
  readonly readSecret?: (name: string) => Promise<string>;
};

const runtimeIsInteractive = (runtime: RuntimeInfo): boolean =>
  runtime.stdinIsTty && runtime.stdoutIsTty && runtime.stderrIsTty;

const runtimeCanShowAuthHandoff = (runtime: RuntimeInfo): boolean =>
  runtime.stdoutIsTty && runtime.stderrIsTty;

export type DoctorCheck = {
  readonly name:
    | "profile"
    | "runtime"
    | "config"
    | "image"
    | "auth"
    | "state"
    | "discovery"
    | "models";
  readonly status: "passed" | "failed" | "skipped";
  readonly message: string;
};

export type DoctorReport = {
  readonly checks: readonly DoctorCheck[];
};

export type DeploymentStatusReport = {
  readonly runtime: ProviderStatusSummary;
  readonly config?: ProviderConfigSummary;
};

export const validateRuntime = (
  intent: CommandIntent,
  runtime: RuntimeInfo,
): AppError | undefined => {
  if (
    intent.command === "tui" &&
    !runtimeIsInteractive(runtime)
  ) {
    return {
      code: "runtime.ttyRequired",
      message: intent.explicit
        ? "TUI mode requires stdin, stdout, and stderr to be attached to a TTY."
        : "No command was provided, and TUI mode requires stdin, stdout, and stderr to be attached to a TTY. Run a command such as setup --no-input, status, or doctor for non-interactive use.",
    };
  }

  if (
    intent.command === "secrets.set" &&
    intent.source.type === "prompt" &&
    !runtime.stdinIsTty
  ) {
    return {
      code: "runtime.ttyRequired",
      message:
        "secrets set requires an interactive terminal prompt. Use --from-env or --value-stdin for non-interactive input.",
    };
  }

  if (
    intent.command === "setup" &&
    intent.globals.inputMode === "interactive" &&
    !runtime.stdinIsTty
  ) {
    return {
      code: "runtime.ttyRequired",
      message:
        "Interactive setup requires stdin to be attached to a TTY. Use setup --no-input with complete provider arguments for non-interactive setup.",
    };
  }

  if (
    intent.globals.auth === "browser" &&
    !runtimeCanShowAuthHandoff(runtime)
  ) {
    return {
      code: "runtime.ttyRequired",
      message: "--auth browser requires interactive stdout and stderr.",
    };
  }

  if (intent.globals.auth === "device" && !runtimeCanShowAuthHandoff(runtime)) {
    return {
      code: "runtime.ttyRequired",
      message: "--auth device requires interactive stdout and stderr.",
    };
  }

  return undefined;
};

const profileName = (intent: CommandIntent): string =>
  intent.globals.profile ?? "default";

const profileStoreUnavailable = (intent: CommandIntent): CommandResult => ({
  ok: false,
  command: intent.command,
  error: {
    code: "profile.storeUnavailable",
    message: "Profile storage is not configured for this command.",
  },
});

const missingProvider = (): AppError => ({
  code: "args.missing",
  message: "Missing required provider. Use --provider gcp or --provider azure.",
});

const missingDeployment = (): AppError => ({
  code: "args.missing",
  message: "Missing required deployment identity. Use --deployment <name>.",
});

const missingProviderField = (
  provider: ProviderTarget["provider"],
  field: string,
): AppError => ({
  code: "args.missing",
  message: `Missing required ${provider.toUpperCase()} field. Use --${field} <value>.`,
});

const invalidProviderField = (
  provider: ProviderTarget["provider"],
  field: string,
): AppError => ({
  code: "args.invalid",
  message: `--${field} is not valid for provider ${provider}.`,
});

const invalidProviderFieldValue = (
  provider: ProviderTarget["provider"],
  field: string,
): AppError => ({
  code: "args.invalid",
  message: `--${field} for provider ${provider} must be ${providerFieldAllowedValues(provider, field)?.join(" or ")}.`,
});

const providerFieldsMatch = (
  provider: ProviderTarget["provider"],
  fields: Readonly<Record<string, string>>,
): AppError | undefined => {
  const field = invalidProviderFields(provider, fields)[0];
  if (field) return invalidProviderField(provider, field);

  const valueField = invalidProviderFieldValues(provider, fields)[0];
  return valueField ? invalidProviderFieldValue(provider, valueField) : undefined;
};

type GlobalProviderInput = {
  readonly profile: string;
  readonly provider: ProviderTarget["provider"];
  readonly fields: Readonly<Record<string, string>>;
};

const globalProviderInput = (
  intent: CommandIntent,
): GlobalProviderInput | AppError => {
  const profile = profileName(intent);
  const profileError = validateProfileName(profile);
  if (profileError) return profileError;

  const provider = intent.globals.provider;
  if (!provider) return missingProvider();

  const fields = intent.globals.providerFields;
  const fieldError = providerFieldsMatch(provider, fields);
  return fieldError ? fieldError : { profile, provider, fields };
};

const targetFromGlobals = (intent: CommandIntent): ProviderTarget | AppError => {
  const input = globalProviderInput(intent);
  if ("code" in input) return input;

  const deployment = intent.globals.deployment;
  if (!deployment) return missingDeployment();

  const { fields, profile, provider } = input;
  const user = fields["user"] ?? "user";

  if (provider === "gcp") {
    const projectId = fields["project"];
    if (!projectId) return missingProviderField("gcp", "project");

    const region = fields["region"];
    if (!region) return missingProviderField("gcp", "region");

    const stateServer = fields["state-server"];
    const dataPath = gcpStateDataPath(fields);
    const nixPath = gcpStateNixPath(fields);
    const state =
      stateServer && dataPath && nixPath
        ? {
            server: stateServer,
            dataPath,
            nixPath,
          }
        : undefined;
    const serviceAccount = fields["service-account"];

    return {
      provider: "gcp",
      profile,
      deployment,
      user,
      ref: {
        name: deployment,
        projectId,
        region,
      },
      ...(state
        ? {
            deploymentSpec: {
              name: deployment,
              projectId,
              region,
              state,
              ...(serviceAccount ? { serviceAccount } : {}),
            },
          }
        : {}),
      ...(fields["quota-project"] ? { quotaProjectId: fields["quota-project"] } : {}),
    };
  }

  const tenantId = fields["tenant"];
  if (!tenantId) return missingProviderField("azure", "tenant");

  const subscriptionId = fields["subscription"];
  if (!subscriptionId) return missingProviderField("azure", "subscription");

  const resourceGroupName = fields["resource-group"];
  if (!resourceGroupName) return missingProviderField("azure", "resource-group");

  const location = fields["location"];
  const environmentId = fields["environment-id"];
  const storageName = fields["storage-name"];
  const deploymentSpec =
    location && environmentId && storageName
      ? {
          name: deployment,
          subscriptionId,
          resourceGroupName,
          location,
          environmentId,
          state: {
            storageName,
            dataSubPath: azureStateDataSubPath(fields),
            nixSubPath: azureStateNixSubPath(fields),
          },
        }
      : undefined;

  return {
    provider: "azure",
    profile,
    deployment,
    user,
    tenantId,
    ref: {
      name: deployment,
      subscriptionId,
      resourceGroupName,
    },
    ...(deploymentSpec ? { deploymentSpec } : {}),
    ...(fields["endpoint"]
      ? { openaiCompatibleEndpoint: fields["endpoint"] }
      : {}),
  };
};

const authTargetFromGlobals = (
  intent: CommandIntent,
): ProviderAuthTarget | AppError => {
  const input = globalProviderInput(intent);
  if ("code" in input) return input;

  const { fields, profile, provider } = input;
  if (provider === "gcp") {
    return {
      provider: "gcp",
      profile,
      ...(fields["quota-project"] ? { quotaProjectId: fields["quota-project"] } : {}),
    };
  }

  const tenantId = fields["tenant"];
  if (!tenantId) return missingProviderField("azure", "tenant");

  const subscriptionId = fields["subscription"];
  if (!subscriptionId) return missingProviderField("azure", "subscription");

  return {
    provider: "azure",
    profile,
    tenantId,
    subscriptionId,
  };
};

const discoveryTargetFromGlobals = (
  intent: CommandIntent,
): ProviderDiscoveryTarget | AppError => {
  const input = globalProviderInput(intent);
  if ("code" in input) return input;

  const { fields, profile, provider } = input;
  if (provider === "gcp") {
    const projectId = fields["project"];
    if (!projectId) return missingProviderField("gcp", "project");

    const region = fields["region"];
    if (!region) return missingProviderField("gcp", "region");

    return {
      provider: "gcp",
      profile,
      boundary: {
        projectId,
        region,
      },
      ...(fields["quota-project"] ? { quotaProjectId: fields["quota-project"] } : {}),
    };
  }

  const tenantId = fields["tenant"];
  if (!tenantId) return missingProviderField("azure", "tenant");

  const subscriptionId = fields["subscription"];
  if (!subscriptionId) return missingProviderField("azure", "subscription");

  const resourceGroupName = fields["resource-group"];
  if (!resourceGroupName) return missingProviderField("azure", "resource-group");

  return {
    provider: "azure",
    profile,
    tenantId,
    boundary: {
      subscriptionId,
      resourceGroupName,
    },
  };
};

const modelTargetFromGlobals = (
  intent: CommandIntent,
): ProviderModelTarget | AppError => {
  const input = globalProviderInput(intent);
  if ("code" in input) return input;

  const { fields, profile, provider } = input;
  if (provider === "gcp") {
    const region = fields["region"];
    if (!region) return missingProviderField("gcp", "region");

    return {
      provider: "gcp",
      profile,
      region,
      ...(fields["quota-project"] ? { quotaProjectId: fields["quota-project"] } : {}),
    };
  }

  const tenantId = fields["tenant"];
  if (!tenantId) return missingProviderField("azure", "tenant");

  const endpoint = fields["endpoint"];
  if (!endpoint) return missingAzureModelEndpoint();

  return {
    provider: "azure",
    profile,
    tenantId,
    endpoint,
  };
};

const resetProfile = (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  runtime: CommandRuntime,
): CommandResult => {
  if (!runtime.profiles) {
    return profileStoreUnavailable(intent);
  }

  const name = profileName(intent);
  const deleted = runtime.profiles.deleteProfile(name);
  if ("code" in deleted) {
    return {
      ok: false,
      command: "setup",
      error: deleted,
    };
  }

  return {
    ok: true,
    command: "setup",
    profile: name,
    summary: deleted.deleted
      ? `Profile ${name} was reset. No cloud resources were changed.`
      : `Profile ${name} was already absent. No cloud resources were changed.`,
    data: {
      deleted: deleted.deleted,
    },
  };
};

const setupArgsFromIntent = (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
): SetupArgs => ({
  ...(intent.globals.profile ? { profile: intent.globals.profile } : {}),
  ...(intent.globals.provider ? { provider: intent.globals.provider } : {}),
  ...(intent.globals.deployment
    ? { deployment: intent.globals.deployment }
    : {}),
  fields: intent.globals.providerFields,
});

const mergeSetupFields = (
  existing: SetupDraft["fields"],
  input: SetupArgs["fields"],
  providerChanged: boolean,
): SetupDraft["fields"] => {
  const source = providerChanged ? {} : existing;
  const fields: Record<string, string> = {};
  const statePath = input?.["state-path"];
  const stateDataPath = input?.["state-data-path"];
  const stateNixPath = input?.["state-nix-path"];

  for (const [key, value] of Object.entries(source)) {
    if (
      statePath !== undefined &&
      key === "state-data-path" &&
      stateDataPath === undefined
    ) {
      continue;
    }
    if (
      statePath !== undefined &&
      key === "state-nix-path" &&
      stateNixPath === undefined
    ) {
      continue;
    }
    fields[key] = value;
  }

  for (const [key, value] of Object.entries(input ?? {})) {
    if (key !== "user") {
      fields[key] = value;
    }
  }
  return fields;
};

const mergeSetupDraft = (
  existing: SetupDraft,
  input: SetupArgs,
): SetupDraft => {
  const providerChanged =
    input.provider !== undefined && input.provider !== existing.provider;
  const fields = mergeSetupFields(existing.fields, input.fields, providerChanged);
  return {
    profileName: input.profile ?? existing.profileName,
    ...(input.provider ?? existing.provider
      ? { provider: input.provider ?? existing.provider }
      : {}),
    ...(input.deployment ?? existing.deployment
      ? { deployment: input.deployment ?? existing.deployment }
      : {}),
    user: input.fields?.["user"] ?? (providerChanged ? "user" : existing.user),
    fields,
  };
};

type SetupDraftSource = "new" | "existing";

type SetupDraftResult = {
  readonly draft: SetupDraft;
  readonly source: SetupDraftSource;
};

const setupDraft = (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  runtime: CommandRuntime,
): SetupDraftResult | CommandResult => {
  const input = setupArgsFromIntent(intent);
  if (intent.globals.inputMode === "nonInteractive" || !runtime.profiles) {
    return { draft: draftFromArgs(input), source: "new" };
  }

  const existing = runtime.profiles.readProfile(profileName(intent));
  if ("code" in existing) {
    if (existing.code === "profile.notFound") {
      return intent.reconfigure
        ? {
            ok: false,
            command: "setup",
            error: existing,
          }
        : { draft: draftFromArgs(input), source: "new" };
    }
    return {
      ok: false,
      command: "setup",
      error: existing,
    };
  }

  return {
    draft: mergeSetupDraft(draftFromProfile(existing), input),
    source: "existing",
  };
};

const setupPromptFailed = (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  error: unknown,
): CommandResult => ({
  ok: false,
  command: "setup",
  error: {
    code: "runtime.ttyRequired",
    message:
      error instanceof Error
        ? `Interactive setup prompt failed: ${error.message}`
        : "Interactive setup prompt failed.",
  },
});

const promptSetupValue = async (
  promptText: NonNullable<CommandRuntime["promptText"]>,
  label: string,
  current: string | undefined,
): Promise<string> => {
  const answer = await promptText(label, current);
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : current ?? "";
};

const setupValueNeeded = (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  value: string | undefined,
  forcePrompt: boolean,
): boolean =>
  forcePrompt || intent.reconfigure || value === undefined || value.length === 0;

const promptRequiredSetupValue = async (
  promptText: NonNullable<CommandRuntime["promptText"]>,
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  label: string,
  current: string | undefined,
  forcePrompt: boolean,
): Promise<string> => {
  if (setupValueNeeded(intent, current, forcePrompt)) {
    return promptSetupValue(promptText, label, current);
  }
  return current ?? "";
};

const promptSetupFields = async (
  promptText: NonNullable<CommandRuntime["promptText"]>,
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  provider: ProviderTarget["provider"],
  fields: Readonly<Record<string, string>>,
  forcePrompt: boolean,
): Promise<Readonly<Record<string, string>>> => {
  const next: Record<string, string> = { ...fields };

  if (provider === "gcp") {
    next["project"] = await promptRequiredSetupValue(
      promptText,
      intent,
      "GCP project",
      next["project"],
      forcePrompt,
    );
    next["region"] = await promptRequiredSetupValue(
      promptText,
      intent,
      "GCP region",
      next["region"],
      forcePrompt,
    );
    if (!intent.quick || forcePrompt || next["service-account"] !== undefined) {
      const serviceAccount = await promptSetupValue(
        promptText,
        "Cloud Run service account (optional)",
        next["service-account"],
      );
      if (serviceAccount.length > 0) {
        next["service-account"] = serviceAccount;
      } else {
        delete next["service-account"];
      }
    }
    next["state"] = "nfs";
    next["state-server"] = await promptRequiredSetupValue(
      promptText,
      intent,
      "NFS server",
      next["state-server"],
      forcePrompt,
    );
    const sharedStatePath = next["state-path"];
    if (
      setupValueNeeded(intent, sharedStatePath, forcePrompt) &&
      (!next["state-data-path"] || !next["state-nix-path"])
    ) {
      const path = await promptSetupValue(
        promptText,
        "NFS state path",
        sharedStatePath,
      );
      next["state-path"] = path;
    }
    if (next["state-path"]) {
      delete next["state-data-path"];
      delete next["state-nix-path"];
    } else {
      next["state-data-path"] = await promptRequiredSetupValue(
        promptText,
        intent,
        "NFS data path",
        next["state-data-path"],
        forcePrompt,
      );
      next["state-nix-path"] = await promptRequiredSetupValue(
        promptText,
        intent,
        "NFS Nix path",
        next["state-nix-path"],
        forcePrompt,
      );
    }
    return next;
  }

  next["tenant"] = await promptRequiredSetupValue(
    promptText,
    intent,
    "Azure tenant",
    next["tenant"],
    forcePrompt,
  );
  next["subscription"] = await promptRequiredSetupValue(
    promptText,
    intent,
    "Azure subscription",
    next["subscription"],
    forcePrompt,
  );
  next["resource-group"] = await promptRequiredSetupValue(
    promptText,
    intent,
    "Azure resource group",
    next["resource-group"],
    forcePrompt,
  );
  next["location"] = await promptRequiredSetupValue(
    promptText,
    intent,
    "Azure location",
    next["location"],
    forcePrompt,
  );
  next["environment-id"] = await promptRequiredSetupValue(
    promptText,
    intent,
    "Container Apps environment resource ID",
    next["environment-id"],
    forcePrompt,
  );
  next["state"] = "azure-files";
  next["storage-name"] = await promptRequiredSetupValue(
    promptText,
    intent,
    "Container Apps environment storage name",
    next["storage-name"],
    forcePrompt,
  );
  if (!intent.quick || forcePrompt || next["endpoint"] !== undefined) {
    const endpoint = await promptSetupValue(
      promptText,
      "Foundry OpenAI-compatible endpoint",
      next["endpoint"],
    );
    if (endpoint.length > 0) {
      next["endpoint"] = endpoint;
    } else {
      delete next["endpoint"];
    }
  }
  return next;
};

const promptSetupDraft = async (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  runtime: CommandRuntime,
  draft: SetupDraft,
  forcePrompt: boolean,
): Promise<SetupDraft | CommandResult> => {
  const promptText = runtime.promptText;
  if (
    intent.globals.outputMode === "tui" ||
    intent.globals.inputMode !== "interactive" ||
    !promptText
  ) {
    return draft;
  }

  try {
    const providerInput = draft.provider
      ? draft.provider
      : await promptSetupValue(promptText, "Provider (gcp or azure)", undefined);
    const provider =
      providerInput === "gcp" || providerInput === "azure"
        ? providerInput
        : undefined;

    if (!provider) {
      return {
        ok: false,
        command: "setup",
        error: {
          code: "provider.invalid",
          message: "Provider must be gcp or azure.",
        },
      };
    }

    const deployment = await promptRequiredSetupValue(
      promptText,
      intent,
      "Deployment",
      draft.deployment,
      forcePrompt,
    );
    const user = await promptRequiredSetupValue(
      promptText,
      intent,
      "Container user",
      draft.user,
      forcePrompt,
    );
    const fields = await promptSetupFields(
      promptText,
      intent,
      provider,
      draft.fields,
      forcePrompt,
    );

    return {
      profileName: draft.profileName,
      provider,
      deployment,
      user,
      fields,
    };
  } catch (error) {
    return setupPromptFailed(intent, error);
  }
};

const setupReadOnlyCheck = async <A>(
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  effect: Effect.Effect<A, CloudError>,
  context: ResultContext,
): Promise<CommandResult | undefined> => {
  const outcome = await Effect.runPromise(Effect.either(effect));
  return Either.match(outcome, {
    onLeft: (error) => withResultContext(cloudErrorResult(intent, error), context),
    onRight: () => undefined,
  });
};

const validateSetupProvider = async (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
  runtime: CommandRuntime,
  profile: AppProfile,
): Promise<CommandResult | undefined> => {
  const context = profileResultContext(profile);
  const authTarget = authTargetFromProfile(profile, intent.globals.providerFields);
  const authRunner = authRunnerForTarget(intent, runtime, authTarget);
  if ("ok" in authRunner) {
    return withResultContext(authRunner, context);
  }

  const authError = await setupReadOnlyCheck(
    intent,
    authRunner.authCheck(),
    context,
  );
  if (authError) {
    return authError;
  }

  const discoveryTarget = discoveryTargetFromProfile(
    profile,
    intent.globals.providerFields,
  );
  const discoveryRunner = discoveryRunnerForTarget(
    intent,
    runtime,
    discoveryTarget,
  );
  if ("ok" in discoveryRunner) {
    return withResultContext(discoveryRunner, context);
  }

  const discoveryError = await setupReadOnlyCheck(
    intent,
    discoveryRunner.discover(),
    context,
  );
  if (discoveryError) {
    return discoveryError;
  }

  const target = targetFromProfile(profile, intent.globals.providerFields);
  const runner = runnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return withResultContext(runner, context);
  }

  return runner.validateSetup
    ? setupReadOnlyCheck(intent, runner.validateSetup(), context)
    : undefined;
};

const profileProviderFieldsMatch = (
  profile: AppProfile,
  fields: Readonly<Record<string, string>>,
): AppError | undefined => {
  const conflictingField = invalidProviderFields(profile.provider, fields)[0];
  if (conflictingField) {
    return {
      code: "args.invalid",
      message: `--${conflictingField} is not valid for profile ${profile.name}, which uses provider ${profile.provider}.`,
    };
  }

  const invalidValueField = invalidProviderFieldValues(profile.provider, fields)[0];
  if (invalidValueField) {
    const allowed = providerFieldAllowedValues(profile.provider, invalidValueField) ?? [];
    return {
      code: "args.invalid",
      message: `--${invalidValueField} for profile ${profile.name} must be ${allowed.join(" or ")}.`,
    };
  }

  return undefined;
};

const profileMatchesIntent = (
  intent: CommandIntent,
  profile: AppProfile,
): AppError | undefined => {
  if (intent.globals.provider && intent.globals.provider !== profile.provider) {
    return {
      code: "args.invalid",
      message: `Profile ${profile.name} is for ${profile.provider}, not ${intent.globals.provider}.`,
    };
  }
  if (
    intent.globals.deployment &&
    intent.globals.deployment !== profile.deployment
  ) {
    return {
      code: "args.invalid",
      message: `Profile ${profile.name} targets deployment ${profile.deployment}, not ${intent.globals.deployment}.`,
    };
  }

  return profileProviderFieldsMatch(profile, intent.globals.providerFields);
};

const hasExplicitTargetInput = (intent: CommandIntent): boolean =>
  intent.globals.provider !== undefined ||
  intent.globals.deployment !== undefined ||
  Object.keys(intent.globals.providerFields).length > 0;

const hasExplicitProviderInput = (intent: CommandIntent): boolean =>
  intent.globals.provider !== undefined ||
  Object.keys(intent.globals.providerFields).length > 0;

const appErrorResult = (
  intent: CommandIntent,
  error: AppError,
  context?: ResultContext,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...(context ?? {}),
  error,
});

const isAppError = <T extends object>(value: T | AppError): value is AppError =>
  "code" in value;

const loadProfileBackedTarget = <T extends object>(
  intent: CommandIntent,
  runtime: CommandRuntime,
  fromGlobals: () => T | AppError,
  fromProfile: (profile: AppProfile) => T | AppError,
): T | CommandResult => {
  const explicitTarget = hasExplicitTargetInput(intent);
  if (!runtime.profiles || (!intent.globals.profile && explicitTarget)) {
    const target = fromGlobals();
    return isAppError(target)
      ? explicitTarget
        ? appErrorResult(intent, target)
        : profileStoreUnavailable(intent)
      : target;
  }

  const profile = runtime.profiles.readProfile(profileName(intent));
  if ("code" in profile) {
    if (profile.code === "profile.notFound") {
      const inputTarget = fromGlobals();
      if (!isAppError(inputTarget)) {
        return inputTarget;
      }
      if (explicitTarget) {
        return appErrorResult(intent, inputTarget);
      }
    }

    return appErrorResult(intent, profile);
  }

  const mismatch = profileMatchesIntent(intent, profile);
  if (mismatch) {
    return appErrorResult(intent, mismatch);
  }

  const target = fromProfile(profile);
  return isAppError(target)
    ? appErrorResult(intent, target, profileResultContext(profile))
    : target;
};

const loadTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): ProviderTarget | CommandResult =>
  loadProfileBackedTarget(
    intent,
    runtime,
    () => targetFromGlobals(intent),
    (profile) => targetFromProfile(profile, intent.globals.providerFields),
  );

const loadAuthTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): ProviderAuthTarget | CommandResult =>
  loadProfileBackedTarget(
    intent,
    runtime,
    () => authTargetFromGlobals(intent),
    (profile) => authTargetFromProfile(profile, intent.globals.providerFields),
  );

const loadModelTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): ProviderModelTarget | CommandResult =>
  loadProfileBackedTarget(
    intent,
    runtime,
    () => modelTargetFromGlobals(intent),
    (profile) => modelTargetFromProfile(profile, intent.globals.providerFields),
  );

const doctorProfileModelCheck = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
  profile: AppProfile,
  authCheck: DoctorCheck,
): Promise<DoctorCheck> => {
  if (authCheck.status === "failed") {
    return doctorCheck("models", "skipped", "Skipped because auth check failed.");
  }

  const target = modelTargetFromProfile(profile, intent.globals.providerFields);
  if ("code" in target) {
    return doctorTargetErrorCheck("models", target, "skipped");
  }

  const runner = modelRunnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return doctorCommandResultCheck("models", runner);
  }

  return doctorEffectCheck(
    "models",
    runner.listModels(),
    "Provider model catalog access succeeded.",
  );
};

type PreviewResource = ProviderDeployPreviewSummary["resources"][number];
type PreviewAction = PreviewResource["action"];

const previewActionOrder: readonly PreviewAction[] = [
  "create",
  "reuse",
  "update",
];

const previewActionLabel = (action: PreviewAction): string =>
  action === "create"
    ? "to create"
    : action === "reuse"
      ? "to reuse"
      : "to update";

const previewResourceKindLabel = (
  resource: PreviewResource,
): string => {
  switch (resource.resourceKind) {
    case "cloud-run-service":
      return "Cloud Run service";
    case "container-app":
      return "Container App";
    case "nfs-state":
      return "NFS state";
    case "managed-environment-storage":
      return "managed environment storage";
  }
};

const previewResourceText = (resource: PreviewResource): string =>
  `${previewResourceKindLabel(resource)} ${resource.resourceName}`;

const previewStateText = (summary: ProviderDeployPreviewSummary): string =>
  summary.state.kind === "nfs"
    ? `State: NFS ${summary.state.server}:${summary.state.dataPath} for ${HERMES_DATA_MOUNT_PATH} and ${summary.state.server}:${summary.state.nixPath} for ${HERMES_NIX_MOUNT_PATH}; deploy mounts existing state and leaves contents intact.`
    : `State: Azure Files storage ${summary.state.storageName}, subpaths ${summary.state.dataSubPath} for ${HERMES_DATA_MOUNT_PATH} and ${summary.state.nixSubPath} for ${HERMES_NIX_MOUNT_PATH}; deploy mounts existing state and leaves contents intact.`;

const previewConfigText =
  "Config/secrets: unchanged by deploy; use config and secrets commands for runtime settings and secret values.";

type RuntimeMutationPreview = {
  readonly status: ProviderStatusSummary;
  readonly runtimeSecrets?: readonly string[];
};

const deploymentPreviewText = (
  provider: ProviderTarget["provider"],
  summary: ProviderDeployPreviewSummary,
): string => {
  const boundary =
    "projectId" in summary.boundary
      ? `project ${summary.boundary.projectId}, region ${summary.boundary.region}`
      : `subscription ${summary.boundary.subscriptionId}, resource group ${summary.boundary.resourceGroupName}, location ${summary.boundary.location}`;

  const resourceGroups = previewActionOrder.flatMap((action) => {
    const resources = summary.resources
      .filter((resource) => resource.action === action)
      .map(previewResourceText);

    return resources.length === 0
      ? []
      : [`${previewActionLabel(action)}: ${resources.join(", ")}`];
  });

  return `${provider} deployment preview in ${boundary}. Resources ${resourceGroups.join("; ")}. ${previewConfigText} ${previewStateText(summary)}`;
};

const targetResourceKind = (target: ProviderTarget): string =>
  target.provider === "gcp" ? "Cloud Run service" : "Container App";

const targetResourceKindSlug = (target: ProviderTarget): string =>
  target.provider === "gcp" ? "cloud-run-service" : "container-app";

const targetBoundaryText = (target: ProviderTarget): string =>
  target.provider === "gcp"
    ? `project ${target.ref.projectId}, region ${target.ref.region}`
    : `subscription ${target.ref.subscriptionId}, resource group ${target.ref.resourceGroupName}`;

const runtimeStatusPreviewText = (
  target: ProviderTarget,
  status: ProviderStatusSummary,
): string => {
  const resource = `${target.provider} ${targetResourceKind(target)} ${target.deployment}`;
  const boundary = targetBoundaryText(target);
  const image = status.image ? ` Current image: ${status.image}.` : "";
  const endpoint = status.endpoint ? ` Endpoint: ${status.endpoint}.` : "";

  return status.deployed
    ? `${resource} is deployed in ${boundary}.${image}${endpoint}`
    : `${resource} is not currently deployed in ${boundary}.`;
};

const destroyRuntimeSecretsText = (
  preview: RuntimeMutationPreview | undefined,
): string => {
  if (!preview?.status.deployed) {
    return "Runtime secrets: none will be deleted because the runtime is not deployed.";
  }

  const secrets = preview.runtimeSecrets ?? [];
  return secrets.length === 0
    ? "Runtime secrets: none currently wired into the deployment."
    : `Runtime secrets to delete: ${secrets.join(", ")}.`;
};

const destroyStateText = (
  intent: CommandIntent,
  target: ProviderTarget,
): string => {
  if (intent.command !== "destroy") {
    return "";
  }
  if (intent.state === "purge") {
    return target.provider === "azure"
      ? "Persistent Azure Files state subpaths will be purged after the Container App is deleted."
      : "Persistent state was requested for deletion.";
  }
  if (intent.state === "retain") {
    return "Persistent state will be retained.";
  }
  return "Choose --retain-state or --purge-state before confirming.";
};

const commandPreviewText = (
  intent: CommandIntent,
  target: ProviderTarget,
  preview?: ProviderDeployPreviewSummary,
  runtime?: RuntimeMutationPreview,
): string | undefined => {
  if (preview) return deploymentPreviewText(target.provider, preview);

  const current = runtime
    ? `${runtimeStatusPreviewText(target, runtime.status)} `
    : "";
  const resource = `${target.provider} ${targetResourceKind(target)} ${target.deployment}`;
  const boundary = targetBoundaryText(target);
  if (intent.command === "restart") {
    return `${current}${resource} in ${boundary} will be rolled so the runtime starts with current config and secrets.`;
  }
  if (intent.command === "destroy") {
    return `${current}${resource} in ${boundary} will be deleted. ${destroyRuntimeSecretsText(runtime)} ${destroyStateText(intent, target)}`;
  }

  return undefined;
};

const confirmationPromptText = (intent: CommandIntent): string => {
  if (intent.globals.outputMode === "tui") {
    if (intent.command === "deploy") {
      return "Confirm deploy after reviewing this preview.";
    }
    if (intent.command === "restart") {
      return "Confirm restart to roll the runtime.";
    }
    if (intent.command === "destroy") {
      return intent.state
        ? "Confirm destroy after reviewing the state retention choice."
        : "Choose state retention before confirming destroy.";
    }
  }

  if (intent.command === "deploy") {
    return "Re-run deploy with --yes after reviewing this preview.";
  }
  if (intent.command === "restart") {
    return "Re-run restart with --yes to roll the runtime.";
  }
  if (intent.command === "destroy") {
    if (intent.state === "purge") {
      return "Re-run destroy with --purge-state --yes after reviewing this preview; human CLI mode will also ask you to type the deployment name.";
    }
    return intent.state === "retain"
      ? "Re-run destroy with --retain-state --yes after reviewing the state retention choice."
      : "Re-run destroy with --retain-state --yes or --purge-state --yes after reviewing this preview.";
  }
  return `${intent.command} changes cloud resources. Re-run with --yes after reviewing what will change.`;
};

const confirmationRequired = (
  intent: CommandIntent,
  target: ProviderTarget,
  preview?: ProviderDeployPreviewSummary,
  runtime?: RuntimeMutationPreview,
): CommandResult => {
  const previewText = commandPreviewText(intent, target, preview, runtime);
  const prompt = confirmationPromptText(intent);

  return {
    ok: false,
    command: intent.command,
    ...targetResultContext(target),
    error: {
      code: "command.confirmationRequired",
      message: [...(previewText ? [previewText] : []), prompt].join(
        " ",
      ),
    },
  };
};

const invalidSecretName = (intent: CommandIntent, name: string): CommandResult => ({
  ok: false,
  command: intent.command,
  error: {
    code: "args.invalid",
    message: `Secret name ${name} is invalid. ${RUNTIME_SECRET_NAME_MESSAGE}`,
  },
});

const missingEnvironmentSecret = (
  intent: CommandIntent,
  name: string,
): CommandResult => ({
  ok: false,
  command: intent.command,
  error: {
    code: "args.missing",
    message: `Environment variable ${name} is not set.`,
  },
});

type ConfigSetIntent = Extract<
  CommandIntent,
  { readonly command: "config.set" }
>;

type ProfileCommandIntent = Extract<
  CommandIntent,
  {
    readonly command: "deploy" | "status" | "restart" | "destroy";
  }
>;

type ConfigCommandIntent = Extract<
  CommandIntent,
  { readonly command: "config.show" | "config.set" }
>;

type SecretsCommandIntent = Extract<
  CommandIntent,
  { readonly command: "secrets.list" | "secrets.set" | "secrets.delete" }
>;

const nonEmptyConfigValue = (
  key: HermesConfigSetKey,
  value: string,
): AppError | undefined =>
  value.trim().length > 0
    ? undefined
    : {
        code: "args.invalid",
        message: `Config key ${key} requires a non-empty value.`,
      };

const integerConfigValue = (
  key: HermesConfigSetKey,
  value: string,
  minimum: number,
  maximum?: number,
): AppError | undefined => {
  const parsed = Number(value);
  const inRange =
    Number.isInteger(parsed) &&
    parsed >= minimum &&
    (maximum === undefined || parsed <= maximum);
  return inRange
    ? undefined
    : {
        code: "args.invalid",
        message:
          maximum === undefined
            ? `Config key ${key} must be an integer greater than or equal to ${minimum}.`
            : `Config key ${key} must be an integer from ${minimum} to ${maximum}.`,
      };
};

const modelDefaultPatch = (
  intent: ConfigSetIntent,
  target: ProviderTarget,
): HomeManagerPatch | AppError => {
  const error = nonEmptyConfigValue("model.default", intent.value);
  if (error) return error;

  const value = intent.value.trim();
  if (target.provider === "gcp") {
    return renderHermesModelPatch({
      provider: "gcp",
      model: value,
    });
  }

  const endpoint = (
    intent.globals.providerFields["endpoint"] ??
    target.openaiCompatibleEndpoint
  )?.trim();
  if (!endpoint) {
    return {
      code: "args.missing",
      message:
        "Azure model.default config requires --endpoint <azure-openai-compatible-endpoint> so Hermes receives a complete Foundry deployment configuration.",
    };
  }

  return renderHermesModelPatch({
    provider: "azure",
    endpoint,
    deploymentName: value,
  });
};

const configSetPatch = (
  intent: ConfigSetIntent,
  target: ProviderTarget,
): HomeManagerPatch | AppError => {
  if (!isHermesConfigSetKey(intent.key)) {
    return {
      code: "args.invalid",
      message: `Config key ${intent.key} is not in the supported v1 set.`,
    };
  }

  if (intent.key === "model.default") {
    return modelDefaultPatch(intent, target);
  }

  if (intent.key === "model.api_mode") {
    if (target.provider !== "azure") {
      return {
        code: "args.invalid",
        message:
          "Config key model.api_mode is only supported for Azure Foundry deployments.",
      };
    }
    return isAzureFoundryOpenAICompatibleApiMode(intent.value)
      ? renderHermesSettingPatch(intent.key, intent.value)
      : {
          code: "args.invalid",
          message:
            "Config key model.api_mode must be chat_completions or codex_responses for the Azure Foundry OpenAI-compatible route.",
        };
  }

  if (intent.key === "gateway.port") {
    const error = integerConfigValue(intent.key, intent.value, 1, 65_535);
    return error
      ? error
      : renderHermesSettingPatch(intent.key, Number(intent.value));
  }
  if (intent.key === "agent.max_turns") {
    const error = integerConfigValue(intent.key, intent.value, 1);
    return error
      ? error
      : renderHermesSettingPatch(intent.key, Number(intent.value));
  }
  if (
    intent.key === "agent.reasoning_effort" &&
    !isHermesReasoningEffort(intent.value)
  ) {
    return {
      code: "args.invalid",
      message:
        "Config key agent.reasoning_effort must be none, minimal, low, medium, high, or xhigh.",
      };
  }

  const error = nonEmptyConfigValue(intent.key, intent.value);
  return error
    ? error
    : renderHermesSettingPatch(intent.key, intent.value.trim());
};

const configUserVolumeUnavailable = (
  intent: CommandIntent,
  target: ProviderTarget,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...targetResultContext(target),
  error: {
    code: "config.unavailable",
    message: `${target.provider} does not have a concrete Home Manager user-volume mutation path wired for this command yet.`,
  },
});

const configReadUnavailable = (
  intent: CommandIntent,
  target: ProviderTarget,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...targetResultContext(target),
  error: {
    code: "config.unavailable",
    message:
      target.provider === "gcp"
        ? "GCP config show needs an explicit Cloud Run output channel; the current NFS-backed path is write-only from the deployer."
        : `${target.provider} does not have a concrete Home Manager read path wired for this command yet.`,
  },
});

const secretPromptUnavailable = (
  intent: Extract<CommandIntent, { readonly command: "secrets.set" }>,
): CommandResult => ({
  ok: false,
  command: intent.command,
  error: {
    code: "runtime.ttyRequired",
    message:
      "Interactive secret entry is unavailable in this runtime. Use --from-env or --value-stdin.",
  },
});

const secretPromptFailed = (
  intent: Extract<CommandIntent, { readonly command: "secrets.set" }>,
  error: unknown,
): CommandResult => ({
  ok: false,
  command: intent.command,
  error: {
    code: "runtime.ttyRequired",
    message:
      error instanceof Error
        ? `Interactive secret entry failed: ${error.message}`
      : "Interactive secret entry failed.",
  },
});

const statePurgePromptUnavailable = (
  intent: Extract<CommandIntent, { readonly command: "destroy" }>,
  target: ProviderTarget,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...targetResultContext(target),
  error: {
    code: "runtime.ttyRequired",
    message:
      "destroy --purge-state requires an interactive terminal acknowledgement in human CLI mode. Re-run in a TTY and type the deployment name, or use --json for explicit automation.",
  },
});

const statePurgePromptFailed = (
  intent: Extract<CommandIntent, { readonly command: "destroy" }>,
  target: ProviderTarget,
  error: unknown,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...targetResultContext(target),
  error: {
    code: "runtime.ttyRequired",
    message:
      error instanceof Error
        ? `State purge acknowledgement failed: ${error.message}`
        : "State purge acknowledgement failed.",
  },
});

const statePurgeConfirmationRejected = (
  intent: Extract<CommandIntent, { readonly command: "destroy" }>,
  target: ProviderTarget,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...targetResultContext(target),
  error: {
    code: "command.confirmationRequired",
    message:
      `destroy --purge-state was not confirmed. Type ${target.deployment} to permanently delete provider-owned persistent state for this deployment.`,
  },
});

const secretStdinUnavailable = (intent: CommandIntent): CommandResult => ({
  ok: false,
  command: intent.command,
  error: {
    code: "runtime.stdinUnavailable",
    message: "Reading secret values from stdin is not available in this runtime.",
  },
});

const secretValueFromSource = async (
  intent: Extract<CommandIntent, { readonly command: "secrets.set" }>,
  runtime: CommandRuntime,
): Promise<string | CommandResult> => {
  const source = intent.source;
  if (source.type === "env") {
    const value = runtime.env?.[source.name];
    return value === undefined
      ? missingEnvironmentSecret(intent, source.name)
      : value;
  }
  if (source.type === "stdin") {
    return runtime.readStdin ? runtime.readStdin() : secretStdinUnavailable(intent);
  }

  if (!runtime.readSecret) {
    return secretPromptUnavailable(intent);
  }

  return runtime.readSecret(intent.name).catch((error: unknown) =>
    secretPromptFailed(intent, error)
  );
};

const mutatingCommandIsConfirmed = (intent: CommandIntent): boolean => {
  if (intent.globals.outputMode === "json") {
    return true;
  }
  if (intent.command === "deploy" || intent.command === "restart") {
    return intent.yes;
  }
  if (intent.command === "destroy") {
    return intent.yes;
  }
  return true;
};

const confirmStatePurge = async (
  intent: Extract<CommandIntent, { readonly command: "destroy" }>,
  runtime: CommandRuntime,
  target: ProviderTarget,
): Promise<CommandResult | undefined> => {
  if (intent.state !== "purge" || intent.globals.outputMode !== "cli") {
    return undefined;
  }

  if (intent.globals.inputMode !== "interactive" || !runtime.promptText) {
    return statePurgePromptUnavailable(intent, target);
  }

  const label = `Type ${target.deployment} to delete persistent state for ${target.provider} profile ${target.profile}`;
  const answer = await runtime.promptText(label).catch((error: unknown) =>
    statePurgePromptFailed(intent, target, error)
  );
  if (typeof answer !== "string") {
    return answer;
  }

  return answer === target.deployment
    ? undefined
    : statePurgeConfirmationRejected(intent, target);
};

const cloudErrorRemediations = (
  error: CloudError,
): readonly Remediation[] => {
  if (error._tag === "RemediationRequired") {
    return [error.remediation];
  }
  return [];
};

const cloudErrorCode = (error: CloudError): AppError["code"] =>
  error._tag === "RemediationRequired" && error.remediation.type === "auth"
    ? "auth.unavailable"
    : "provider.failed";

const cloudErrorResult = (
  intent: CommandIntent,
  error: CloudError,
): CommandResult => {
  const remediations = cloudErrorRemediations(error);
  return {
    ok: false,
    command: intent.command,
    error: {
      code: cloudErrorCode(error),
      message: error.message,
    },
    ...(remediations.length > 0 ? { remediations } : {}),
  };
};

const commandResultMessage = (result: CommandResult): string =>
  result.ok ? result.summary : result.error.message;

const targetResultContext = (target: ProviderTarget): ResultContext => ({
  profile: target.profile,
  provider: target.provider,
  deployment: target.deployment,
});

const authTargetResultContext = (target: ProviderAuthTarget): ResultContext => ({
  profile: target.profile,
  provider: target.provider,
});

const discoveryTargetResultContext = (
  target: ProviderDiscoveryTarget,
): ResultContext => ({
  profile: target.profile,
  provider: target.provider,
});

const modelTargetResultContext = (
  target: ProviderModelTarget,
): ResultContext => ({
  profile: target.profile,
  provider: target.provider,
});

type ProviderCommandTarget =
  | ProviderTarget
  | ProviderAuthTarget
  | ProviderDiscoveryTarget
  | ProviderModelTarget;

const providerTargetResultContext = (
  target: ProviderCommandTarget,
): ResultContext =>
  "deployment" in target
    ? targetResultContext(target)
    : "boundary" in target
      ? discoveryTargetResultContext(target)
      : "region" in target || "endpoint" in target
        ? modelTargetResultContext(target)
        : authTargetResultContext(target);

const profileResultContext = (profile: AppProfile): ResultContext => ({
  profile: profile.name,
  provider: profile.provider,
  deployment: profile.deployment,
});

const loadDiscoveryTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): ProviderDiscoveryTarget | CommandResult =>
  loadProfileBackedTarget(
    intent,
    runtime,
    () => discoveryTargetFromGlobals(intent),
    (profile) => discoveryTargetFromProfile(profile, intent.globals.providerFields),
  );

const withResultContext = (
  result: CommandResult,
  context: ResultContext | undefined,
): CommandResult => (context ? { ...result, ...context } : result);

const commandDebug = (
  intent: CommandIntent,
  raw: unknown,
): Partial<Pick<Extract<CommandResult, { readonly ok: true }>, "debug">> =>
  intent.globals.debug ? { debug: redactDebugValue(raw) } : {};

const redactedDebugValue = "[redacted]";

const sensitiveDebugKeys = new Set([
  "accesstoken",
  "accountkey",
  "authorization",
  "apikey",
  "clientsecret",
  "idtoken",
  "password",
  "refreshtoken",
  "secretvalue",
  "token",
]);

const normalizedDebugKey = (key: string): string =>
  key.toLowerCase().replace(/[-_]/g, "");

const shouldRedactDebugField = (
  key: string,
  parentKey: string | undefined,
): boolean => {
  const normalized = normalizedDebugKey(key);
  if (sensitiveDebugKeys.has(normalized)) {
    return true;
  }

  const parent = parentKey ? normalizedDebugKey(parentKey) : "";
  return (
    (normalized === "value" && parent.includes("secret")) ||
    (normalized === "data" && parent === "payload")
  );
};

const redactDebugValue = (
  value: unknown,
  parentKey?: string,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => redactDebugValue(entry, parentKey));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      shouldRedactDebugField(key, parentKey)
        ? redactedDebugValue
        : redactDebugValue(entry, key),
    ]),
  );
};

const deploymentStatusResult = (
  runtime: ProviderOperationResult<ProviderStatusSummary>,
  config?: ProviderConfigSummary,
): ProviderOperationResult<DeploymentStatusReport> => ({
  summary: {
    runtime: runtime.summary,
    ...(config ? { config } : {}),
  },
  raw: {
    runtime: runtime.raw,
    ...(config ? { config } : {}),
  },
});

const configReadStatusSummary = (
  config: ProviderConfigRead,
): ProviderConfigSummary => ({
  configured: config.configured,
  ...(config.managedModuleHash
    ? { managedModuleHash: config.managedModuleHash }
    : {}),
});

const deploymentStatus = (
  runner: ProviderRunner,
): Effect.Effect<
  ProviderOperationResult<DeploymentStatusReport>,
  CloudError
> => {
  const readConfig = runner.readHomeManagerConfig;
  if (!readConfig) {
    return Effect.map(runner.status(), (runtime) =>
      deploymentStatusResult(runtime),
    );
  }

  return Effect.gen(function* () {
    const runtime = yield* runner.status();
    if (!runtime.summary.deployed) {
      return deploymentStatusResult(runtime);
    }
    const config = configReadStatusSummary(yield* readConfig());
    return deploymentStatusResult(runtime, config);
  });
};

const restartMutationPreview = (
  runner: ProviderRunner,
): Effect.Effect<RuntimeMutationPreview, CloudError> =>
  Effect.map(runner.status(), (status) => ({
    status: status.summary,
  }));

const destroyMutationPreview = (
  runner: ProviderRunner,
): Effect.Effect<RuntimeMutationPreview, CloudError> =>
  Effect.gen(function* () {
    const status = yield* runner.status();
    if (!status.summary.deployed) {
      return {
        status: status.summary,
        runtimeSecrets: [],
      };
    }

    const runtimeSecrets = yield* runner.listSecrets();
    return {
      status: status.summary,
      runtimeSecrets,
    };
  });

const authRemediationForProvider = (
  provider: ProviderCommandTarget["provider"],
): Remediation =>
  provider === "gcp"
    ? gcpApplicationDefaultCredentialsRemediation
    : azureIdentityCredentialsRemediation;

const authUnavailable = (
  intent: CommandIntent,
  target: ProviderCommandTarget,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...providerTargetResultContext(target),
  error: {
    code: "auth.unavailable",
    message:
      target.provider === "azure"
        ? "Azure auth for this command requires interactive browser/device auth or non-interactive Azure Identity environment, workload identity, or managed identity credentials."
        : "GCP auth currently uses Application Default Credentials; use --auth auto.",
  },
  remediations: [authRemediationForProvider(target.provider)],
});

const credentialsForIntent = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): LocalCredentialRequest => {
  const promptless = commandMustNotPrompt(intent);
  const inputMode =
    promptless || runtime.runtimeInfo?.stdinIsTty === false
      ? "nonInteractive"
      : intent.globals.inputMode;
  const noBrowser =
    promptless ||
    (runtime.runtimeInfo !== undefined &&
      !runtimeCanShowAuthHandoff(runtime.runtimeInfo))
      ? true
      : intent.globals.noBrowser;

  return {
    inputMode,
    noBrowser,
    env: runtime.env ?? {},
    ...(runtime.deviceCodePrompt && !promptless
      ? { deviceCodePrompt: runtime.deviceCodePrompt }
      : {}),
    ...(intent.globals.auth ? { mode: intent.globals.auth } : {}),
  };
};

const authRunnerForTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
  target: ProviderAuthTarget,
): ProviderAuthRunner | CommandResult => {
  const factory = runtime.authRunners ?? makeDefaultProviderAuthRunner;
  const credentials = credentialsForIntent(intent, runtime);
  const runner = factory(target, credentials);

  return runner ?? authUnavailable(intent, target);
};

const authCheckDiscoveryTargetFromGlobals = (
  intent: CommandIntent,
): ProviderDiscoveryTarget | undefined => {
  const target = discoveryTargetFromGlobals(intent);
  return isAppError(target) ? undefined : target;
};

const authCheckDiscoveryTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): ProviderDiscoveryTarget | undefined => {
  const inputTarget = authCheckDiscoveryTargetFromGlobals(intent);
  if (inputTarget) {
    return inputTarget;
  }
  if (!intent.globals.profile && hasExplicitProviderInput(intent)) {
    return undefined;
  }

  const profile = runtime.profiles?.readProfile(profileName(intent));
  if (!profile || "code" in profile) {
    return undefined;
  }

  const profileMismatch = profileMatchesIntent(intent, profile);
  return profileMismatch
    ? undefined
    : discoveryTargetFromProfile(profile, intent.globals.providerFields);
};

const authBoundaryRunnerForTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): ProviderDiscoveryRunner | CommandResult | undefined => {
  const target = authCheckDiscoveryTarget(intent, runtime);
  if (!target) return undefined;

  return discoveryRunnerForTarget(intent, runtime, target);
};

const discoveryRunnerForTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
  target: ProviderDiscoveryTarget,
): ProviderDiscoveryRunner | CommandResult => {
  const factory = runtime.discoveryRunners ?? makeDefaultProviderDiscoveryRunner;
  const credentials = credentialsForIntent(intent, runtime);
  const runner = factory(target, credentials);

  return runner ?? authUnavailable(intent, target);
};

const modelRunnerForTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
  target: ProviderModelTarget,
): ProviderModelRunner | CommandResult => {
  const factory = runtime.modelRunners ?? makeDefaultProviderModelRunner;
  const credentials = credentialsForIntent(intent, runtime);
  const runner = factory(target, credentials);

  return runner ?? authUnavailable(intent, target);
};

const runnerForTarget = (
  intent: CommandIntent,
  runtime: CommandRuntime,
  target: ProviderTarget,
): ProviderRunner | CommandResult => {
  const factory = runtime.runners ?? makeDefaultProviderRunner;
  const credentials = credentialsForIntent(intent, runtime);
  const runner = factory(target, credentials);

  return runner ?? authUnavailable(intent, target);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dataWithOperationEvents = (
  data: unknown,
  operationEvents: readonly CloudEvent[],
): unknown => {
  if (operationEvents.length === 0) return data;
  if (data === undefined) return { operationEvents };
  if (isRecord(data)) return { ...data, operationEvents };
  return { value: data, operationEvents };
};

const resultWithOperationEvents = (
  intent: CommandIntent,
  result: CommandResult,
  operationEvents: readonly CloudEvent[],
): CommandResult => {
  if (
    intent.globals.outputMode !== "json" ||
    !result.ok ||
    operationEvents.length === 0
  ) {
    return result;
  }

  return {
    ...result,
    data: dataWithOperationEvents(result.data, operationEvents),
  };
};

const errorResultWithOperationEvents = (
  intent: CommandIntent,
  result: CommandResult,
  operationEvents: readonly CloudEvent[],
): CommandResult => {
  if (
    intent.globals.outputMode !== "json" ||
    result.ok ||
    operationEvents.length === 0
  ) {
    return result;
  }

  return {
    ...result,
    diagnostics: [...(result.diagnostics ?? []), ...operationEvents],
  };
};

const withCommandCloudLog = <A>(
  intent: CommandIntent,
  effect: Effect.Effect<A, CloudError>,
  operationEvents: CloudEvent[],
): Effect.Effect<A, CloudError> => {
  if (intent.globals.outputMode === "json") {
    return Effect.provideService(effect, CloudLog, {
      emit: (event) =>
        Effect.sync(() => {
          operationEvents.push(event);
        }),
    });
  }

  return intent.globals.outputMode === "cli"
    ? Effect.provide(effect, CloudLog.console)
    : effect;
};

const runEffect = async <A>(
  intent: CommandIntent,
  effect: Effect.Effect<A, CloudError>,
  result: (value: A) => CommandResult,
  context?: ResultContext,
): Promise<CommandResult> => {
  const operationEvents: CloudEvent[] = [];
  const outcome = await Effect.runPromise(
    Effect.either(withCommandCloudLog(intent, effect, operationEvents)),
  );
  return Either.match(outcome, {
    onLeft: (error) =>
      withResultContext(
        errorResultWithOperationEvents(
          intent,
          cloudErrorResult(intent, error),
          operationEvents,
        ),
        context,
      ),
    onRight: (value) =>
      withResultContext(
        resultWithOperationEvents(intent, result(value), operationEvents),
        context,
      ),
  });
};

const doctorCheck = (
  name: DoctorCheck["name"],
  status: DoctorCheck["status"],
  message: string,
): DoctorCheck => ({
  name,
  status,
  message,
});

const doctorEffectCheck = async <A>(
  name: DoctorCheck["name"],
  effect: Effect.Effect<A, CloudError>,
  passedMessage: string,
): Promise<DoctorCheck> => {
  const outcome = await Effect.runPromise(Effect.either(effect));
  return Either.match(outcome, {
    onLeft: (error) => doctorCheck(name, "failed", error.message),
    onRight: () => doctorCheck(name, "passed", passedMessage),
  });
};

const doctorCommandResultCheck = (
  name: DoctorCheck["name"],
  result: CommandResult,
): DoctorCheck => doctorCheck(name, "failed", commandResultMessage(result));

const doctorTargetErrorCheck = (
  name: DoctorCheck["name"],
  error: AppError,
  status: DoctorCheck["status"] = "failed",
): DoctorCheck => doctorCheck(name, status, error.message);

const doctorRuntimeCheck = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): DoctorCheck => {
  if (intent.globals.outputMode === "json") {
    return doctorCheck(
      "runtime",
      "passed",
      "JSON mode is non-interactive and will not prompt or open a browser.",
    );
  }

  if (intent.globals.inputMode === "nonInteractive") {
    return doctorCheck(
      "runtime",
      "passed",
      "Non-interactive mode will not prompt or open a browser.",
    );
  }

  const runtimeInfo = runtime.runtimeInfo;
  if (!runtimeInfo) {
    return doctorCheck(
      "runtime",
      "skipped",
      "Runtime TTY information is unavailable.",
    );
  }

  const authHandoffAvailable = runtimeCanShowAuthHandoff(runtimeInfo);
  if (intent.globals.auth === "browser") {
    if (intent.globals.noBrowser) {
      return doctorCheck(
        "runtime",
        "failed",
        "Browser auth was selected but browser handoff is disabled.",
      );
    }
    return authHandoffAvailable
      ? doctorCheck(
          "runtime",
          "passed",
          "Browser auth can use this interactive terminal.",
        )
      : doctorCheck(
          "runtime",
          "failed",
          "Browser auth requires interactive stdout and stderr.",
        );
  }

  if (intent.globals.auth === "device") {
    return authHandoffAvailable
      ? doctorCheck(
          "runtime",
          "passed",
          "Device auth can show the authorization code in this terminal.",
        )
      : doctorCheck(
          "runtime",
          "failed",
          "Device auth requires interactive stdout and stderr.",
        );
  }

  if (intent.globals.noBrowser) {
    return doctorCheck(
      "runtime",
      "passed",
      "Browser handoff is disabled; auth must use ambient credentials.",
    );
  }

  return authHandoffAvailable
    ? doctorCheck(
        "runtime",
        "passed",
        "Interactive terminal is available for auth handoffs.",
      )
    : doctorCheck(
        "runtime",
        "skipped",
        "No interactive terminal is available for browser or device auth handoffs.",
      );
};

const doctorGcpConfigCheck = (): DoctorCheck =>
  doctorCheck(
    "config",
    "passed",
    "GCP model configuration can be rendered for the Gemini runtime path.",
  );

const doctorAzureConfigCheck = (endpoint: string | undefined): DoctorCheck =>
  endpoint
    ? doctorCheck(
        "config",
        "passed",
        "Azure Foundry OpenAI-compatible endpoint is configured.",
      )
    : doctorCheck(
        "config",
        "skipped",
        "Azure Foundry model configuration requires --endpoint or a profile endpoint.",
    );

const doctorImageCheck = (): DoctorCheck =>
  isUniversalHermesImageConfigured()
    ? doctorCheck(
        "image",
        "passed",
        "Universal Hermes runtime image is configured.",
      )
    : doctorCheck(
        "image",
        "failed",
        "Universal Hermes runtime image is still a placeholder; deploy cannot create or update the cloud runtime.",
      );

const doctorStateCheck = async (
  target: ProviderTarget,
  runner: ProviderRunner,
  authCheck: DoctorCheck,
): Promise<DoctorCheck> => {
  if (authCheck.status === "failed") {
    return doctorCheck("state", "skipped", "Skipped because auth check failed.");
  }
  if (!target.deploymentSpec) {
    return doctorCheck(
      "state",
      "skipped",
      "Deployment state check requires a complete deployment spec.",
    );
  }
  if (!runner.validateSetup) {
    return doctorCheck(
      "state",
      "skipped",
      "Provider setup validation is unavailable.",
    );
  }

  return doctorEffectCheck(
    "state",
    runner.validateSetup(),
    "Deployment state prerequisites passed provider validation.",
  );
};

const doctorExplicitStateCheck = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
  authCheck: DoctorCheck,
): Promise<DoctorCheck | undefined> => {
  const target = targetFromGlobals(intent);
  if ("code" in target) {
    return undefined;
  }

  const runner = runnerForTarget(intent, runtime, target);
  return "ok" in runner
    ? doctorCommandResultCheck("state", runner)
    : doctorStateCheck(target, runner, authCheck);
};

const doctorExplicitConfigCheck = (intent: CommandIntent): DoctorCheck => {
  if (intent.globals.provider === "gcp") {
    return doctorGcpConfigCheck();
  }
  if (intent.globals.provider === "azure") {
    return doctorAzureConfigCheck(intent.globals.providerFields["endpoint"]);
  }
  return doctorCheck(
    "config",
    "skipped",
    "Skipped because provider input is incomplete.",
  );
};

const doctorProfileConfigCheck = (
  intent: CommandIntent,
  profile: AppProfile,
): DoctorCheck => {
  if (profile.provider === "gcp") {
    return doctorGcpConfigCheck();
  }
  return doctorAzureConfigCheck(
    intent.globals.providerFields["endpoint"] ??
      profile.azure.openaiCompatibleEndpoint,
  );
};

const doctorSummary = (
  profile: string,
  provider: AppProfile["provider"] | undefined,
  checks: readonly DoctorCheck[],
): string => {
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  const providerText = provider ? `${provider} ` : "";
  return `Doctor checked ${providerText}profile ${profile}: ${passed} passed, ${failed} failed, ${skipped} skipped.`;
};

const targetCommandSummary = (
  target: ProviderTarget,
  action: string,
): string =>
  `${target.provider} profile ${target.profile} ${action} deployment ${target.deployment}.`;

const targetNotDeployedSummary = (target: ProviderTarget): string =>
  `${target.provider} profile ${target.profile} deployment ${target.deployment} is not deployed.`;

const missingDeploymentSpecFields = (
  intent: CommandIntent,
  target: ProviderTarget,
): readonly string[] => {
  const fields = intent.globals.providerFields;
  if (target.provider === "gcp") {
    const missing = [
      ...(fields["state-server"] ? [] : ["state-server"]),
      ...missingGcpStatePathFields(fields),
    ];
    return missing;
  }

  return [
    ...(fields["location"] ? [] : ["location"]),
    ...(fields["environment-id"] ? [] : ["environment-id"]),
    ...(fields["storage-name"] ? [] : ["storage-name"]),
  ];
};

const fullDeploymentRequired = (
  intent: CommandIntent,
  target: ProviderTarget,
): CommandResult => {
  const fields = missingDeploymentSpecFields(intent, target);
  const suffix =
    fields.length > 0
      ? ` Missing: ${fields.map((field) => `--${field}`).join(", ")}.`
      : "";
  return {
    ok: false,
    command: intent.command,
    ...targetResultContext(target),
    error: {
      code: "args.missing",
      message: `${intent.command} requires a complete ${target.provider} deployment spec.${suffix}`,
    },
  };
};

const statePurgeUnavailable = (
  intent: Extract<CommandIntent, { readonly command: "destroy" }>,
  target: ProviderTarget,
): CommandResult => ({
  ok: false,
  command: intent.command,
  ...targetResultContext(target),
  error: {
    code: "state.unavailable",
    message:
      target.provider === "gcp"
        ? "destroy --purge-state is unavailable for GCP NFS state because this deployer does not own the backing NFS server."
        : `${target.provider} does not have a concrete state purge path for destroy yet.`,
  },
});

const runProfileCommand = async (
  intent: ProfileCommandIntent,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const target = loadTarget(intent, runtime);
  if ("ok" in target) {
    return target;
  }
  const context = targetResultContext(target);

  const runner = runnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return runner;
  }

  if (intent.command === "destroy" && intent.state === "purge") {
    if (!target.deploymentSpec) {
      return fullDeploymentRequired(intent, target);
    }
    if (!runner.destroyWithStatePurge) {
      return statePurgeUnavailable(intent, target);
    }
  }

  if (!mutatingCommandIsConfirmed(intent)) {
    if (intent.command === "deploy") {
      if (!runner.previewDeploy) {
        return fullDeploymentRequired(intent, target);
      }

      return runEffect(intent, runner.previewDeploy(), (data) =>
        confirmationRequired(intent, target, data.summary), context);
    }

    const previewEffect = intent.command === "destroy"
      ? destroyMutationPreview(runner)
      : restartMutationPreview(runner);
    return runEffect(intent, previewEffect, (data) =>
      confirmationRequired(intent, target, undefined, data), context);
  }

  if (intent.command === "destroy") {
    const confirmation = await confirmStatePurge(intent, runtime, target);
    if (confirmation) {
      return confirmation;
    }
  }

  switch (intent.command) {
    case "deploy": {
      if (!runner.deploy) {
        return fullDeploymentRequired(intent, target);
      }
      return runEffect(intent, runner.deploy(), (data) => ({
        ok: true,
        command: intent.command,
        summary: targetCommandSummary(target, "deployed"),
        data: data.summary,
        ...commandDebug(intent, data.raw),
      }), context);
    }
    case "status":
      return runEffect(intent, deploymentStatus(runner), (data) => {
        const runtime = data.summary.runtime;
        return {
          ok: true,
          command: intent.command,
          summary: runtime.deployed
            ? `${target.provider} ${targetResourceKindSlug(target)} ${target.deployment} is deployed.`
            : targetNotDeployedSummary(target),
          data: data.summary,
          ...commandDebug(intent, data.raw),
        };
      }, context);
    case "restart":
      return runEffect(intent, runner.restart(), (data) => ({
        ok: true,
        command: intent.command,
        summary: targetCommandSummary(target, "restarted"),
        data: data.summary,
        ...commandDebug(intent, data.raw),
      }), context);
    case "destroy":
      if (intent.state === "purge") {
        if (!target.deploymentSpec) {
          return fullDeploymentRequired(intent, target);
        }
        if (!runner.destroyWithStatePurge) {
          return statePurgeUnavailable(intent, target);
        }
        return runEffect(intent, runner.destroyWithStatePurge(), (data) => ({
          ok: true,
          command: intent.command,
          summary: `${target.provider} profile ${target.profile} destroyed deployment ${target.deployment} and purged its persistent state.`,
          data: data.summary,
          ...commandDebug(intent, data.raw),
        }), context);
      }
      return runEffect(intent, runner.destroy(), (data) => ({
        ok: true,
        command: intent.command,
        summary: targetCommandSummary(target, "destroyed"),
        data: data.summary,
        ...commandDebug(intent, data.raw),
      }), context);
  }
};

const runAuthCheckCommand = async (
  intent: Extract<CommandIntent, { readonly command: "auth.check" }>,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const target = loadAuthTarget(intent, runtime);
  if ("ok" in target) {
    return target;
  }
  const context = authTargetResultContext(target);
  const runner = authRunnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return runner;
  }

  const boundaryRunner = authBoundaryRunnerForTarget(intent, runtime);
  if (boundaryRunner && "ok" in boundaryRunner) {
    return withResultContext(boundaryRunner, context);
  }

  const check = Effect.gen(function* () {
    const auth = yield* runner.authCheck();
    if (!boundaryRunner) {
      return { auth };
    }

    const discovery = yield* boundaryRunner.discover();
    return { auth, discovery };
  });

  return runEffect(intent, check, (data) => ({
    ok: true,
    command: intent.command,
    summary: data.discovery
      ? `${target.provider} profile ${target.profile} can authenticate and reach the selected cloud boundary.`
      : `${target.provider} profile ${target.profile} can authenticate.`,
    data: {
      ...data.auth,
      ...(data.discovery ? { boundaryChecked: true } : {}),
    },
    ...(data.discovery ? commandDebug(intent, data.discovery.raw) : {}),
  }), context);
};

const runConfigCommand = async (
  intent: ConfigCommandIntent,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const target = loadTarget(intent, runtime);
  if ("ok" in target) {
    return target;
  }
  const context = targetResultContext(target);

  switch (intent.command) {
    case "config.show": {
      const runner = runnerForTarget(intent, runtime, target);
      if ("ok" in runner) {
        return runner;
      }
      if (!runner.readHomeManagerConfig) {
        return target.provider === "azure" && !target.deploymentSpec
          ? fullDeploymentRequired(intent, target)
          : configReadUnavailable(intent, target);
      }

      return runEffect(intent, runner.readHomeManagerConfig(), (data) => ({
        ok: true,
        command: intent.command,
        summary: data.configured
          ? `${target.provider} config for deployment ${target.deployment} is present.`
          : `${target.provider} config for deployment ${target.deployment} has no Hermes Ambit managed module yet.`,
        data,
      }), context);
    }
    case "config.set": {
      const patch = configSetPatch(intent, target);
      if ("code" in patch) {
        return {
          ok: false,
          command: intent.command,
          ...context,
          error: patch,
        };
      }

      const runner = runnerForTarget(intent, runtime, target);
      if ("ok" in runner) {
        return runner;
      }
      if (!runner.applyHomeManagerPatch) {
        return target.deploymentSpec
          ? configUserVolumeUnavailable(intent, target)
          : fullDeploymentRequired(intent, target);
      }

      return runEffect(intent, runner.applyHomeManagerPatch(patch), (data) => ({
        ok: true,
        command: intent.command,
        summary: `${target.provider} config ${intent.key} was updated for deployment ${target.deployment} and the runtime was rolled.`,
        data: data.summary,
        ...commandDebug(intent, data.raw),
      }), context);
    }
  }
};

const runSecretsCommand = async (
  intent: SecretsCommandIntent,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const target = loadTarget(intent, runtime);
  if ("ok" in target) {
    return target;
  }
  const context = targetResultContext(target);

  const runner = runnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return runner;
  }

  switch (intent.command) {
    case "secrets.list":
      return runEffect(intent, runner.listSecrets(), (data) => ({
        ok: true,
        command: intent.command,
        summary: `${target.provider} profile ${target.profile} has ${data.length} configured secrets.`,
        data,
      }), context);
    case "secrets.set": {
      if (!isRuntimeSecretName(intent.name)) {
        return withResultContext(invalidSecretName(intent, intent.name), context);
      }
      const value = await secretValueFromSource(intent, runtime);
      if (typeof value !== "string") {
        return withResultContext(value, context);
      }
      return runEffect(intent, runner.putSecret(intent.name, value), (data) => ({
        ok: true,
        command: intent.command,
        summary: `${target.provider} secret ${intent.name} was updated and the runtime environment was rolled.`,
        data: data.summary,
        ...commandDebug(intent, data.raw),
      }), context);
    }
    case "secrets.delete": {
      if (!isRuntimeSecretName(intent.name)) {
        return withResultContext(invalidSecretName(intent, intent.name), context);
      }
      return runEffect(intent, runner.deleteSecret(intent.name), (data) => ({
        ok: true,
        command: intent.command,
        summary: `${target.provider} secret ${intent.name} was deleted and the runtime environment was rolled.`,
        data: data.summary,
        ...commandDebug(intent, data.raw),
      }), context);
    }
  }
};

const doctorProfile = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): { readonly profile?: AppProfile; readonly check: DoctorCheck } => {
  const name = profileName(intent);
  if (!runtime.profiles) {
    return {
      check: doctorCheck(
        "profile",
        "failed",
        "Profile storage is not configured.",
      ),
    };
  }

  const profile = runtime.profiles.readProfile(name);
  if ("code" in profile) {
    return {
      check: doctorCheck("profile", "failed", profile.message),
    };
  }

  const mismatch = profileMatchesIntent(intent, profile);
  if (mismatch) {
    return {
      check: doctorCheck("profile", "failed", mismatch.message),
    };
  }

  return {
    profile,
    check: doctorCheck("profile", "passed", `Profile ${name} is valid.`),
  };
};

const doctorExplicitProfileCheck = (intent: CommandIntent): DoctorCheck => {
  const name = profileName(intent);
  const profileError = validateProfileName(name);
  return profileError
    ? doctorTargetErrorCheck("profile", profileError)
    : doctorCheck(
        "profile",
        "skipped",
        "Using explicit provider input; local profile was not loaded.",
      );
};

const runExplicitDoctorCommand = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const selectedProfile = profileName(intent);
  const profileCheck = doctorExplicitProfileCheck(intent);
  const runtimeCheck = doctorRuntimeCheck(intent, runtime);
  const configCheck = doctorExplicitConfigCheck(intent);
  const imageCheck = doctorImageCheck();
  const authTarget = authTargetFromGlobals(intent);
  const provider = "code" in authTarget
    ? intent.globals.provider
    : authTarget.provider;

  if (profileCheck.status === "failed") {
    return doctorResult(selectedProfile, provider, [
      profileCheck,
      runtimeCheck,
      configCheck,
      imageCheck,
    ]);
  }

  if ("code" in authTarget) {
    return doctorResult(selectedProfile, provider, [
      profileCheck,
      runtimeCheck,
      configCheck,
      imageCheck,
      doctorTargetErrorCheck("auth", authTarget),
      doctorCheck("discovery", "skipped", "Skipped because auth target is incomplete."),
      doctorCheck("models", "skipped", "Skipped because auth target is incomplete."),
    ]);
  }

  const authRunner = authRunnerForTarget(intent, runtime, authTarget);
  if ("ok" in authRunner) {
    return doctorResult(selectedProfile, provider, [
      profileCheck,
      runtimeCheck,
      configCheck,
      imageCheck,
      doctorCommandResultCheck("auth", authRunner),
      doctorCheck("discovery", "skipped", "Skipped because auth is unavailable."),
      doctorCheck("models", "skipped", "Skipped because auth is unavailable."),
    ]);
  }

  const authCheck = await doctorEffectCheck(
    "auth",
    authRunner.authCheck(),
    "Auth context produced an access token.",
  );
  const discoveryCheck =
    authCheck.status === "failed"
      ? doctorCheck("discovery", "skipped", "Skipped because auth check failed.")
      : await doctorDiscoveryCheck(intent, runtime);
  const stateCheck = await doctorExplicitStateCheck(intent, runtime, authCheck);
  const modelCheck =
    authCheck.status === "failed"
      ? doctorCheck("models", "skipped", "Skipped because auth check failed.")
      : await doctorModelCheck(intent, runtime);

  return doctorResult(selectedProfile, provider, [
    profileCheck,
    runtimeCheck,
    configCheck,
    imageCheck,
    authCheck,
    ...(stateCheck ? [stateCheck] : []),
    discoveryCheck,
    modelCheck,
  ]);
};

const doctorDiscoveryCheck = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
): Promise<DoctorCheck> => {
  const target = discoveryTargetFromGlobals(intent);
  if ("code" in target) {
    return doctorTargetErrorCheck("discovery", target);
  }

  const runner = discoveryRunnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return doctorCommandResultCheck("discovery", runner);
  }

  return doctorEffectCheck(
    "discovery",
    runner.discover(),
    "Provider boundary discovery succeeded.",
  );
};

const doctorModelCheck = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
): Promise<DoctorCheck> => {
  const target = modelTargetFromGlobals(intent);
  if ("code" in target) {
    return doctorTargetErrorCheck("models", target, "skipped");
  }

  const runner = modelRunnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return doctorCommandResultCheck("models", runner);
  }

  return doctorEffectCheck(
    "models",
    runner.listModels(),
    "Provider model catalog access succeeded.",
  );
};

const doctorResult = (
  profile: string,
  provider: AppProfile["provider"] | undefined,
  checks: readonly DoctorCheck[],
): CommandResult => {
  const data: DoctorReport = {
    checks,
  };
  return {
    ok: true,
    command: "doctor",
    profile,
    ...(provider ? { provider } : {}),
    summary: doctorSummary(profile, provider, checks),
    data,
  };
};

const runDoctorCommand = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  if (!intent.globals.profile && hasExplicitProviderInput(intent)) {
    return runExplicitDoctorCommand(intent, runtime);
  }

  const selectedProfile = profileName(intent);
  const runtimeCheck = doctorRuntimeCheck(intent, runtime);
  const profileResult = doctorProfile(intent, runtime);
  const profile = profileResult.profile;
  const imageCheck = doctorImageCheck();
  if (!profile) {
    return doctorResult(selectedProfile, undefined, [
      profileResult.check,
      runtimeCheck,
      imageCheck,
    ]);
  }

  const configCheck = doctorProfileConfigCheck(intent, profile);
  const target = targetFromProfile(profile, intent.globals.providerFields);
  const runner = runnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return doctorResult(selectedProfile, profile.provider, [
      profileResult.check,
      runtimeCheck,
      configCheck,
      imageCheck,
      doctorCheck("auth", "failed", commandResultMessage(runner)),
      doctorCheck("state", "skipped", "Skipped because auth is unavailable."),
      doctorCheck("discovery", "skipped", "Skipped because auth is unavailable."),
      doctorCheck("models", "skipped", "Skipped because auth is unavailable."),
    ]);
  }

  const authCheck = await doctorEffectCheck(
    "auth",
    runner.authCheck(),
    "Auth context produced an access token.",
  );
  const discoveryCheck =
    authCheck.status === "failed"
      ? doctorCheck("discovery", "skipped", "Skipped because auth check failed.")
      : await doctorEffectCheck(
          "discovery",
          runner.discover(),
          "Provider boundary discovery succeeded.",
        );
  const stateCheck = await doctorStateCheck(target, runner, authCheck);
  const modelCheck = await doctorProfileModelCheck(
    intent,
    runtime,
    profile,
    authCheck,
  );

  return doctorResult(selectedProfile, profile.provider, [
    profileResult.check,
    runtimeCheck,
    configCheck,
    imageCheck,
    authCheck,
    stateCheck,
    discoveryCheck,
    modelCheck,
  ]);
};

const runDiscoverCommand = async (
  intent: CommandIntent,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const target = loadDiscoveryTarget(intent, runtime);
  if ("ok" in target) {
    return target;
  }
  const context = discoveryTargetResultContext(target);

  const runner = discoveryRunnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return runner;
  }

  return runEffect(intent, runner.discover(), (data) => ({
    ok: true,
    command: "discover",
    summary: `${target.provider} profile ${target.profile} found ${data.summary.deployments.length} Hermes deployment resources.`,
    data: data.summary,
    ...commandDebug(intent, data.raw),
  }), context);
};

const runModelsListCommand = async (
  intent: Extract<CommandIntent, { readonly command: "models.list" }>,
  runtime: CommandRuntime,
): Promise<CommandResult> => {
  const target = loadModelTarget(intent, runtime);
  if ("ok" in target) {
    return target;
  }
  const context = modelTargetResultContext(target);

  const runner = modelRunnerForTarget(intent, runtime, target);
  if ("ok" in runner) {
    return runner;
  }

  return runEffect(intent, runner.listModels(), (data) => ({
    ok: true,
    command: "models.list",
    summary:
      target.provider === "azure"
        ? `${target.provider} profile ${target.profile} found ${data.summary.length} model catalog entries. Configure Hermes with an Azure deployment name.`
        : `${target.provider} profile ${target.profile} found ${data.summary.length} supported models.`,
    data: data.summary,
    ...commandDebug(intent, data.raw),
  }), context);
};

export const runIntent = async (
  intent: ExecutableCommandIntent,
  runtime: CommandRuntime = {},
): Promise<CommandResult> => {
  switch (intent.command) {
    case "setup": {
      if (intent.reset) {
        return resetProfile(intent, runtime);
      }

      const initial = setupDraft(intent, runtime);
      if ("ok" in initial) {
        return initial;
      }
      const forcePrompt = initial.source === "existing" && !intent.quick;
      const draft = await promptSetupDraft(
        intent,
        runtime,
        initial.draft,
        forcePrompt,
      );
      if ("ok" in draft) {
        return draft;
      }
      const errors = validateDraft(draft);
      if (errors[0]) {
        return {
          ok: false,
          command: "setup",
          error: errors[0],
        };
      }
      const profile = profileFromDraft(draft);
      if (!profile) {
        return {
          ok: false,
          command: "setup",
          error: {
            code: "args.invalid",
            message: "Setup input did not produce a profile.",
          },
        };
      }

      const providerValidation = await validateSetupProvider(
        intent,
        runtime,
        profile,
      );
      if (providerValidation) {
        return providerValidation;
      }

      const writeError = runtime.profiles?.writeProfile(profile);
      if (writeError) {
        return {
          ok: false,
          command: "setup",
          ...profileResultContext(profile),
          error: writeError,
        };
      }
      const activeProfileError = runtime.profiles?.writeActiveProfileName(
        profile.name,
      );
      if (activeProfileError) {
        return {
          ok: false,
          command: "setup",
          ...profileResultContext(profile),
          error: activeProfileError,
        };
      }

      return {
        ok: true,
        command: "setup",
        ...profileResultContext(profile),
        summary: `Profile ${draft.profileName} ${
          runtime.profiles ? "saved" : "is valid"
        } for ${
          draft.provider ?? "unknown"
        } deployment ${draft.deployment ?? "unknown"}. Read-only provider validation passed.`,
        data: profile,
      };
    }
    case "discover":
      return runDiscoverCommand(intent, runtime);
    case "models.list":
      return runModelsListCommand(intent, runtime);
    case "doctor":
      return runDoctorCommand(intent, runtime);
    case "auth.check":
      return runAuthCheckCommand(intent, runtime);
    case "deploy":
    case "status":
    case "restart":
    case "destroy":
      return runProfileCommand(intent, runtime);
    case "config.show":
    case "config.set":
      return runConfigCommand(intent, runtime);
    case "secrets.list":
    case "secrets.set":
    case "secrets.delete":
      return runSecretsCommand(intent, runtime);
  }
};
