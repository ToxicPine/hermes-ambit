import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";

import type { AppProfile } from "./app-profile.js";
import { runIntent, type CommandRuntime } from "./command.js";
import {
  hermesConfigSetKeysForProvider,
  type HermesConfigSetKey,
} from "./hermes-config.js";
import { renderHuman } from "./render.js";
import {
  profileFromDraft,
  setSetupDraftField,
  setupDraftFields,
  setupDraftMissingFields,
  type SetupDraft,
} from "./setup-state.js";
import { tuiLaunchContext, type TuiLaunchContext } from "./tui-launch.js";
import type {
  CommandResult,
  CommandIntent,
  DestroyState,
  ExecutableCommandIntent,
  GlobalOptions,
  ProviderKind,
} from "./types.js";

type TuiCommand = {
  readonly name: string;
  readonly command: string;
  readonly scope: string;
  readonly detail: string;
  readonly example: string;
  readonly form?: "setup" | "config" | "secrets" | "destroy";
  readonly buildIntent: (globals: GlobalOptions) => ExecutableCommandIntent;
};

type TuiField = {
  readonly label: string;
  readonly value: string;
};

type SecretMode = "list" | "set" | "delete";

type PendingConfirmation = {
  readonly index: number;
  readonly intent: ExecutableCommandIntent;
};

type FocusPane =
  | "commands"
  | "setupFields"
  | "setupValue"
  | "configKeys"
  | "configValue"
  | "configEndpoint"
  | "secretMode"
  | "secretName"
  | "secretValue"
  | "destroyState"
  | "destroyConfirm";

const setupCommand: TuiCommand = {
  name: "Setup",
  command: "setup",
  scope: "profile",
  detail:
    "Create or update a local deployer profile from provider-specific inputs.",
  example: "hermes-ambit setup --provider gcp --deployment personal-agent",
  form: "setup",
  buildIntent: (globals) => ({
    command: "setup",
    globals,
    quick: false,
    reset: false,
    reconfigure: false,
  }),
};

const commands: readonly TuiCommand[] = [
  setupCommand,
  {
    name: "Auth Check",
    command: "auth check",
    scope: "credentials",
    detail:
      "Verify the local provider credential flow for the selected account boundary.",
    example: "hermes-ambit auth check --profile default",
    buildIntent: (globals) => ({ command: "auth.check", globals }),
  },
  {
    name: "Discover",
    command: "discover",
    scope: "provider",
    detail:
      "List existing provider deployments in the selected cloud boundary.",
    example: "hermes-ambit discover --profile default",
    buildIntent: (globals) => ({ command: "discover", globals }),
  },
  {
    name: "Models",
    command: "models",
    scope: "runtime",
    detail:
      "List model catalog entries exposed by the selected provider surface.",
    example: "hermes-ambit models --profile default",
    buildIntent: (globals) => ({ command: "models.list", globals }),
  },
  {
    name: "Deploy",
    command: "deploy",
    scope: "deployment",
    detail:
      "Deploy the selected cloud target after showing the mutation preview.",
    example: "hermes-ambit deploy --profile default",
    buildIntent: (globals) => ({ command: "deploy", globals, yes: false }),
  },
  {
    name: "Status",
    command: "status",
    scope: "deployment",
    detail: "Read provider deployment status and endpoint information.",
    example: "hermes-ambit status --profile default",
    buildIntent: (globals) => ({ command: "status", globals, watch: false }),
  },
  {
    name: "Config",
    command: "config",
    scope: "Hermes",
    detail:
      "Show or update Hermes runtime settings through the provider user-volume path.",
    example:
      "hermes-ambit config set model.default gemini-model-id --profile default",
    form: "config",
    buildIntent: (globals) => ({ command: "config.show", globals }),
  },
  {
    name: "Secrets",
    command: "secrets",
    scope: "Hermes",
    detail: "Manage provider-backed runtime secrets such as model API keys.",
    example: "hermes-ambit secrets set GOOGLE_API_KEY --profile default",
    form: "secrets",
    buildIntent: (globals) => ({ command: "secrets.list", globals }),
  },
  {
    name: "Restart",
    command: "restart",
    scope: "deployment",
    detail: "Roll the runtime so current config and secrets are picked up.",
    example: "hermes-ambit restart --profile default",
    buildIntent: (globals) => ({ command: "restart", globals, yes: false }),
  },
  {
    name: "Destroy",
    command: "destroy",
    scope: "deployment",
    detail:
      "Delete the provider deployment with an explicit state retention choice.",
    example: "hermes-ambit destroy --profile default --retain-state",
    form: "destroy",
    buildIntent: (globals) => ({
      command: "destroy",
      globals,
      yes: false,
      state: "retain",
    }),
  },
  {
    name: "Doctor",
    command: "doctor",
    scope: "diagnostics",
    detail:
      "Run profile, runtime image, config, auth, provider setup, discovery, and model access checks.",
    example: "hermes-ambit doctor --profile default",
    buildIntent: (globals) => ({ command: "doctor", globals }),
  },
];

const configKeyLabels: Record<HermesConfigSetKey, string> = {
  "model.default": "Default model",
  "model.api_mode": "API mode",
  "gateway.host": "Gateway host",
  "gateway.port": "Gateway port",
  "agent.max_turns": "Max turns",
  "agent.reasoning_effort": "Reasoning effort",
};

const profileFlag = (profileName: string): string => `--profile ${profileName}`;

const cliValue = (value: string): string =>
  /\s/.test(value) ? JSON.stringify(value) : value;

const cliFlag = (name: string, value: string | undefined): readonly string[] =>
  value && value.length > 0 ? [`--${name} ${cliValue(value)}`] : [];

const fieldCliArgs = (
  fields: Readonly<Record<string, string>>,
  keys: readonly string[],
): readonly string[] => keys.flatMap((key) => cliFlag(key, fields[key]));

const draftTargetArgs = (draft: SetupDraft): string => {
  const providerKeys = setupDraftFields(draft)
    .map((field) => field.key)
    .filter(
      (key) =>
        key !== "profile" &&
        key !== "provider" &&
        key !== "deployment" &&
        key !== "user",
    );

  return [
    ...cliFlag("provider", draft.provider),
    ...cliFlag("deployment", draft.deployment),
    ...fieldCliArgs(draft.fields, providerKeys),
    ...(draft.user === "user" ? [] : cliFlag("user", draft.user)),
  ].join(" ");
};

const profileTargetArgs = (
  profileName: string,
  fields: Readonly<Record<string, string>>,
): string =>
  [
    profileFlag(profileName),
    ...fieldCliArgs(fields, Object.keys(fields).sort()),
  ].join(" ");

const setupExample = (
  provider: ProviderKind | undefined,
  profileName: string,
  deploymentName: string | undefined,
): string => {
  const target = [
    profileFlag(profileName),
    ...(provider ? [`--provider ${provider}`] : []),
    ...(deploymentName ? [`--deployment ${deploymentName}`] : []),
  ].join(" ");

  return `hermes-ambit setup ${target}`;
};

const modelDefaultExample = (
  provider: ProviderKind | undefined,
  targetArgs: string,
): string => {
  if (provider === "gcp") {
    return `hermes-ambit config set model.default gemini-model-id ${targetArgs}`.trim();
  }
  if (provider === "azure") {
    return `hermes-ambit config set model.default my-gpt-deployment ${targetArgs}`.trim();
  }
  return `hermes-ambit config set model.default MODEL ${targetArgs}`.trim();
};

const runtimeSecretNameExample = (
  provider: ProviderKind | undefined,
): string => {
  if (provider === "gcp") return "GOOGLE_API_KEY";
  if (provider === "azure") return "AZURE_FOUNDRY_API_KEY";
  return "NAME";
};

const runtimeSecretNamePlaceholder = (
  provider: ProviderKind | undefined,
): string => {
  if (provider === "gcp") return "GOOGLE_API_KEY";
  if (provider === "azure") return "AZURE_FOUNDRY_API_KEY";
  return "runtime secret name";
};

const commandExample = (
  command: TuiCommand,
  provider: ProviderKind | undefined,
  profileName: string,
  deploymentName: string | undefined,
  targetArgs: string,
): string => {
  switch (command.command) {
    case "setup":
      return setupExample(provider, profileName, deploymentName);
    case "auth check":
    case "discover":
    case "models":
    case "deploy":
    case "status":
    case "restart":
    case "doctor":
      return `hermes-ambit ${command.command} ${targetArgs}`.trim();
    case "destroy":
      return `hermes-ambit destroy ${targetArgs} --retain-state`.trim();
    case "config":
      return modelDefaultExample(provider, targetArgs);
    case "secrets":
      return `hermes-ambit secrets set ${runtimeSecretNameExample(provider)} ${targetArgs}`.trim();
    default:
      return command.example;
  }
};

const secretModes: readonly SecretMode[] = ["list", "set", "delete"];

const secretModeLabels: Record<SecretMode, string> = {
  list: "List",
  set: "Set",
  delete: "Delete",
};

const secretModeDescriptions: Record<SecretMode, string> = {
  list: "Runtime secret names",
  set: "Store or replace a secret",
  delete: "Remove a secret",
};

const destroyStates: readonly DestroyState[] = ["retain", "purge"];

const destroyStateLabels: Record<DestroyState, string> = {
  retain: "Retain persistent state",
  purge: "Purge persistent state",
};

const providerConfigText = (provider: ProviderKind | undefined): string =>
  hermesConfigSetKeysForProvider(provider).join("\n");

const field = (label: string, value: string | undefined): TuiField => ({
  label,
  value: value && value.length > 0 ? value : "not set",
});

const providerLabel = (provider: ProviderKind | undefined): string =>
  provider ?? "not selected";

const targetFieldsFromProfile = (profile: AppProfile): readonly TuiField[] => {
  if (profile.provider === "gcp") {
    return [
      field("profile", profile.name),
      field("provider", profile.provider),
      field("deployment", profile.deployment),
      field("project", profile.gcp.projectId),
      field("region", profile.gcp.region),
      field("service account", profile.gcp.serviceAccount),
      field("model", profile.gcp.model),
      field("user", profile.user),
      field("quota project", profile.quotaProjectId),
      field("state server", profile.gcp.state.server),
      field("state data path", profile.gcp.state.dataPath),
      field("state nix path", profile.gcp.state.nixPath),
    ];
  }

  return [
    field("profile", profile.name),
    field("provider", profile.provider),
    field("deployment", profile.deployment),
    field("tenant", profile.tenantId),
    field("subscription", profile.azure.subscriptionId),
    field("resource group", profile.azure.resourceGroupName),
    field("location", profile.azure.location),
    field("environment", profile.azure.environmentId),
    field("storage", profile.azure.state.storageName),
    field("model endpoint", profile.azure.openaiCompatibleEndpoint),
    field("model deployment", profile.azure.modelDeployment),
    field("user", profile.user),
  ];
};

const targetFieldsFromDraft = (draft: SetupDraft): readonly TuiField[] => {
  const fields = draft.fields;
  const base = [
    field("profile", draft.profileName),
    field("provider", draft.provider),
    field("deployment", draft.deployment),
  ];
  if (draft.provider === "gcp") {
    return [
      ...base,
      field("project", fields["project"]),
      field("region", fields["region"]),
      field("service account", fields["service-account"]),
      field("quota project", fields["quota-project"]),
      field("model", fields["model"]),
      field("user", draft.user),
      field("state server", fields["state-server"]),
      field("state path", fields["state-path"]),
      field("state data path", fields["state-data-path"]),
      field("state nix path", fields["state-nix-path"]),
    ];
  }
  if (draft.provider === "azure") {
    return [
      ...base,
      field("tenant", fields["tenant"]),
      field("subscription", fields["subscription"]),
      field("resource group", fields["resource-group"]),
      field("location", fields["location"]),
      field("environment", fields["environment-id"]),
      field("storage", fields["storage-name"]),
      field("model endpoint", fields["endpoint"]),
      field("model deployment", fields["model"]),
      field("user", draft.user),
      field("state data subpath", fields["state-data-path"]),
      field("state nix subpath", fields["state-nix-path"]),
    ];
  }
  return [...base];
};

const commandAt = (index: number): TuiCommand =>
  commands[index] ?? setupCommand;

const setupDraftStatusText = (draft: SetupDraft): string => {
  const missing = setupDraftMissingFields(draft);
  return missing.length === 0
    ? "ready"
    : `${missing.length} required field${missing.length === 1 ? "" : "s"} missing`;
};

const globalsFromDraft = (
  globals: GlobalOptions,
  draft: SetupDraft,
  profile: string | undefined,
): GlobalOptions => {
  const {
    profile: _profile,
    provider: _provider,
    deployment: _deployment,
    providerFields: _providerFields,
    ...rest
  } = globals;
  return {
    ...rest,
    ...(profile ? { profile } : {}),
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.deployment ? { deployment: draft.deployment } : {}),
    providerFields: {
      ...draft.fields,
      ...(draft.user ? { user: draft.user } : {}),
    },
  };
};

const globalsFromSetupDraft = (
  globals: GlobalOptions,
  draft: SetupDraft,
): GlobalOptions => globalsFromDraft(globals, draft, draft.profileName);

const globalsFromTargetDraft = (
  globals: GlobalOptions,
  draft: SetupDraft,
): GlobalOptions => globalsFromDraft(globals, draft, undefined);

const confirmedIntent = (
  intent: ExecutableCommandIntent,
): ExecutableCommandIntent => {
  if (intent.command === "deploy") {
    return { ...intent, yes: true };
  }
  if (intent.command === "restart") {
    return { ...intent, yes: true };
  }
  if (intent.command === "destroy") {
    return { ...intent, yes: true, state: intent.state ?? "retain" };
  }
  return intent;
};

const commandNeedsConfirmation = (result: CommandResult): boolean =>
  !result.ok && result.error.code === "command.confirmationRequired";

const TuiApp = (props: {
  readonly context: TuiLaunchContext;
  readonly globals: GlobalOptions;
  readonly runtime: CommandRuntime;
}) => {
  const renderer = useRenderer();
  const initialGlobals =
    props.context.profile && !props.globals.profile
      ? { ...props.globals, profile: props.context.profile.name }
      : props.globals;
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [focusPane, setFocusPane] = createSignal<FocusPane>("commands");
  const [setupDraft, setSetupDraft] = createSignal(props.context.setupDraft);
  const [commandGlobals, setCommandGlobals] = createSignal(initialGlobals);
  const [activeProfile, setActiveProfile] = createSignal(props.context.profile);
  const [profileError, setProfileError] = createSignal(
    props.context.profileError,
  );
  const [setupFieldIndex, setSetupFieldIndex] = createSignal(0);
  const [configKeyIndex, setConfigKeyIndex] = createSignal(0);
  const [configValue, setConfigValue] = createSignal("");
  const [configEndpoint, setConfigEndpoint] = createSignal("");
  const [secretMode, setSecretMode] = createSignal<SecretMode>("list");
  const [secretName, setSecretName] = createSignal("");
  const [secretValue, setSecretValue] = createSignal("");
  const [destroyState, setDestroyState] = createSignal<DestroyState>("retain");
  const [destroyConfirmation, setDestroyConfirmation] = createSignal("");
  const [running, setRunning] = createSignal(false);
  const [output, setOutput] = createSignal("No result yet.");
  const [pendingConfirmation, setPendingConfirmation] =
    createSignal<PendingConfirmation>();
  const launchTarget = props.context.setupDraft;
  const selectedCommand = createMemo(() => commandAt(selectedIndex()));
  const setupFields = createMemo(() => setupDraftFields(setupDraft()));
  const selectedSetupField = createMemo(
    () => setupFields()[setupFieldIndex()] ?? setupFields()[0],
  );
  const setupFieldOptions = createMemo(() =>
    setupFields().map((field, index) => ({
      name: `${field.required ? "*" : "-"} ${field.label}`,
      description: field.value ?? (field.required ? "required" : "optional"),
      value: index,
    })),
  );
  const setupSelected = createMemo(() => selectedCommand().form === "setup");
  const configSelected = createMemo(() => selectedCommand().form === "config");
  const secretsSelected = createMemo(
    () => selectedCommand().form === "secrets",
  );
  const destroySelected = createMemo(
    () => selectedCommand().form === "destroy",
  );
  const draftBackedTarget = createMemo(
    () => !activeProfile() && !commandGlobals().profile,
  );
  const activeProvider = createMemo(
    () =>
      activeProfile()?.provider ??
      (draftBackedTarget() ? setupDraft().provider : undefined) ??
      commandGlobals().provider ??
      props.context.provider ??
      launchTarget.provider,
  );
  const activeProfileName = createMemo(
    () =>
      activeProfile()?.name ??
      commandGlobals().profile ??
      props.context.profileName,
  );
  const activeDeploymentLabel = createMemo(
    () =>
      activeProfile()?.deployment ??
      (draftBackedTarget() ? setupDraft().deployment : undefined) ??
      commandGlobals().deployment ??
      launchTarget.deployment ??
      "not selected",
  );
  const activeDeploymentName = createMemo(
    () =>
      activeProfile()?.deployment ??
      (draftBackedTarget() ? setupDraft().deployment : undefined) ??
      commandGlobals().deployment ??
      launchTarget.deployment,
  );
  const commandExampleProvider = createMemo(() =>
    setupSelected() ? setupDraft().provider : activeProvider(),
  );
  const commandExampleProfileName = createMemo(() =>
    setupSelected() ? setupDraft().profileName : activeProfileName(),
  );
  const commandExampleDeploymentName = createMemo(() =>
    setupSelected() ? setupDraft().deployment : activeDeploymentName(),
  );
  const commandTargetArgs = createMemo(() =>
    activeProfile() || commandGlobals().profile
      ? profileTargetArgs(activeProfileName(), commandGlobals().providerFields)
      : draftTargetArgs(setupDraft()),
  );
  const selectedCommandExample = createMemo(() =>
    commandExample(
      selectedCommand(),
      commandExampleProvider(),
      commandExampleProfileName(),
      commandExampleDeploymentName(),
      commandTargetArgs(),
    ),
  );
  const activeTargetFields = createMemo(() => {
    if (setupSelected()) {
      return targetFieldsFromDraft(setupDraft());
    }
    const profile = activeProfile();
    if (profile) {
      return targetFieldsFromProfile(profile);
    }
    return targetFieldsFromDraft(
      draftBackedTarget() ? setupDraft() : launchTarget,
    );
  });
  const selectedTargetText = createMemo(() =>
    activeTargetFields()
      .map((item) => `${item.label}: ${item.value}`)
      .join("\n"),
  );
  const selectedConfigText = createMemo(() =>
    providerConfigText(
      setupSelected() ? setupDraft().provider : activeProvider(),
    ),
  );
  const configKeys = createMemo(() =>
    hermesConfigSetKeysForProvider(activeProvider()),
  );
  const selectedConfigKey = createMemo(
    () => configKeys()[configKeyIndex()] ?? configKeys()[0] ?? "model.default",
  );
  const activeAzureModelEndpoint = createMemo(() => {
    const profile = activeProfile();
    if (profile?.provider === "azure") {
      return profile.azure.openaiCompatibleEndpoint;
    }
    const fields = draftBackedTarget()
      ? setupDraft().fields
      : commandGlobals().providerFields;
    return fields["endpoint"] ?? props.context.setupDraft.fields["endpoint"];
  });
  const configEndpointSelected = createMemo(
    () =>
      activeProvider() === "azure" && selectedConfigKey() === "model.default",
  );
  const configEndpointValue = createMemo(() => {
    const endpoint = configEndpoint().trim();
    return endpoint.length > 0 ? endpoint : activeAzureModelEndpoint();
  });
  const configKeyOptions = createMemo(() =>
    configKeys().map((key, index) => ({
      name: key,
      description: configKeyLabels[key],
      value: index,
    })),
  );
  const selectedSetupStatusText = createMemo(() =>
    setupDraftStatusText(setupDraft()),
  );
  const secretModeOptions = createMemo(() =>
    secretModes.map((mode, index) => ({
      name: secretModeLabels[mode],
      description: secretModeDescriptions[mode],
      value: index,
    })),
  );
  const secretValueText = createMemo(() =>
    secretValue().length > 0 ? "*".repeat(secretValue().length) : "not set",
  );
  const destroyStateOptions = createMemo(() =>
    destroyStates.map((state, index) => ({
      name: destroyStateLabels[state],
      description: state,
      value: index,
    })),
  );
  const updateSetupField = (value: string) => {
    const field = selectedSetupField();
    if (!field) return;
    const nextDraft = setSetupDraftField(setupDraft(), field.key, value);
    setSetupDraft(nextDraft);
    const nextFields = setupDraftFields(nextDraft);
    const nextIndex = nextFields.findIndex(
      (nextField) => nextField.key === field.key,
    );
    setSetupFieldIndex(nextIndex >= 0 ? nextIndex : 0);
  };
  const selectSecretMode = (index: number): SecretMode | undefined => {
    const mode = secretModes[index];
    if (!mode) return undefined;
    setSecretMode(mode);
    setPendingConfirmation(undefined);
    if (mode !== "set") {
      setSecretValue("");
    }
    return mode;
  };
  const configGlobals = (globals: GlobalOptions): GlobalOptions => {
    if (!configEndpointSelected()) return globals;
    const endpoint = configEndpointValue()?.trim();
    return endpoint && endpoint.length > 0
      ? {
          ...globals,
          providerFields: {
            ...globals.providerFields,
            endpoint,
          },
        }
      : globals;
  };
  const focusNextFormPane = () => {
    const current = focusPane();
    if (setupSelected() && current === "commands") {
      setFocusPane("setupFields");
      return;
    }
    if (setupSelected() && current === "setupFields") {
      setFocusPane("setupValue");
      return;
    }
    if (configSelected() && current === "commands") {
      setFocusPane("configKeys");
      return;
    }
    if (configSelected() && current === "configKeys") {
      setFocusPane("configValue");
      return;
    }
    if (
      configSelected() &&
      current === "configValue" &&
      configEndpointSelected()
    ) {
      setFocusPane("configEndpoint");
      return;
    }
    if (configSelected() && current === "configEndpoint") {
      setFocusPane("commands");
      return;
    }
    if (secretsSelected() && current === "commands") {
      setFocusPane("secretMode");
      return;
    }
    if (secretsSelected() && current === "secretMode") {
      setFocusPane(secretMode() === "list" ? "commands" : "secretName");
      return;
    }
    if (
      secretsSelected() &&
      current === "secretName" &&
      secretMode() === "set"
    ) {
      setFocusPane("secretValue");
      return;
    }
    if (secretsSelected() && current === "secretName") {
      setFocusPane("commands");
      return;
    }
    if (secretsSelected() && current === "secretValue") {
      setFocusPane("commands");
      return;
    }
    if (destroySelected() && current === "commands") {
      setFocusPane("destroyState");
      return;
    }
    if (
      destroySelected() &&
      current === "destroyState" &&
      destroyState() === "purge"
    ) {
      setFocusPane("destroyConfirm");
      return;
    }
    setFocusPane("commands");
  };
  const commandIntent = (
    command: TuiCommand,
    globals: GlobalOptions,
  ): ExecutableCommandIntent => {
    if (command.form === "destroy") {
      return {
        command: "destroy",
        globals,
        yes: false,
        state: destroyState(),
      };
    }

    if (command.form === "secrets") {
      const mode = secretMode();
      if (mode === "list") {
        return command.buildIntent(globals);
      }

      const name = secretName().trim();
      if (mode === "delete") {
        return {
          command: "secrets.delete",
          globals,
          name,
        };
      }

      return {
        command: "secrets.set",
        globals,
        name,
        source: { type: "prompt" },
      };
    }

    if (command.form !== "config") {
      return command.buildIntent(globals);
    }

    const value = configValue().trim();
    return value.length === 0
      ? command.buildIntent(globals)
      : {
          command: "config.set",
          globals: configGlobals(globals),
          key: selectedConfigKey(),
          value,
        };
  };
  const runtimeForIntent = (
    intent: ExecutableCommandIntent,
  ): CommandRuntime => {
    const runtime: CommandRuntime = {
      ...props.runtime,
      deviceCodePrompt: (message) => setOutput(message),
    };

    return intent.command === "secrets.set" && secretValue().length > 0
      ? {
          ...runtime,
          readSecret: async () => secretValue(),
        }
      : runtime;
  };
  const runCommand = (index: number) => {
    const command = commandAt(index);
    const pending = pendingConfirmation();
    const draft = setupDraft();
    const globals =
      command.command === "setup"
        ? globalsFromSetupDraft(commandGlobals(), draft)
        : draftBackedTarget()
          ? globalsFromTargetDraft(commandGlobals(), draft)
          : commandGlobals();
    const intent = commandIntent(command, globals);
    const effectiveIntent =
      pending && pending.index === index
        ? confirmedIntent(pending.intent)
        : intent;

    if (
      effectiveIntent.command === "destroy" &&
      effectiveIntent.yes &&
      effectiveIntent.state === "purge"
    ) {
      const targetName = activeDeploymentName();
      if (!targetName || destroyConfirmation().trim() !== targetName) {
        setOutput(
          targetName
            ? `Type ${targetName} before purging persistent state.`
            : "Select a deployment before purging persistent state.",
        );
        setFocusPane(targetName ? "destroyConfirm" : "commands");
        return;
      }
    }

    if (
      (effectiveIntent.command === "secrets.set" ||
        effectiveIntent.command === "secrets.delete") &&
      effectiveIntent.name.trim().length === 0
    ) {
      setOutput(
        effectiveIntent.command === "secrets.set"
          ? "Enter a secret name before saving."
          : "Enter a secret name before deleting.",
      );
      setFocusPane("secretName");
      return;
    }

    if (
      effectiveIntent.command === "secrets.set" &&
      secretValue().length === 0
    ) {
      setOutput("Enter a secret value before saving.");
      setFocusPane("secretValue");
      return;
    }

    setRunning(true);
    setOutput(`Running ${command.command}...`);
    runIntent(effectiveIntent, runtimeForIntent(effectiveIntent))
      .then((result) => {
        if (commandNeedsConfirmation(result)) {
          setPendingConfirmation({ index, intent });
          setOutput(
            `${renderHuman(result).trimEnd()}\n\n${command.name} is pending confirmation. Select it again to confirm.`,
          );
          return;
        }
        setPendingConfirmation(undefined);
        if (result.ok && command.form === "setup") {
          const profile = profileFromDraft(draft);
          if (profile) {
            setActiveProfile(profile);
          }
          setProfileError(undefined);
          setCommandGlobals(globals);
        }
        setOutput(renderHuman(result).trimEnd());
      })
      .catch((error: unknown) => {
        setPendingConfirmation(undefined);
        setOutput(error instanceof Error ? error.message : "Command failed.");
      })
      .finally(() => {
        if (effectiveIntent.command === "secrets.set") {
          setSecretValue("");
        }
        setRunning(false);
      });
  };
  useKeyboard((key) => {
    if (
      (setupSelected() || configSelected() || secretsSelected()) &&
      key.name === "tab"
    ) {
      key.preventDefault();
      focusNextFormPane();
      return;
    }
    if (
      setupSelected() &&
      focusPane() === "setupFields" &&
      key.name === "enter"
    ) {
      key.preventDefault();
      setFocusPane("setupValue");
      return;
    }
    if (
      configSelected() &&
      focusPane() === "configKeys" &&
      key.name === "enter"
    ) {
      key.preventDefault();
      setFocusPane("configValue");
      return;
    }
    if (
      secretsSelected() &&
      focusPane() === "secretMode" &&
      key.name === "enter"
    ) {
      key.preventDefault();
      setFocusPane(secretMode() === "list" ? "commands" : "secretName");
      return;
    }
    if (
      secretsSelected() &&
      focusPane() === "secretName" &&
      key.name === "enter"
    ) {
      key.preventDefault();
      setFocusPane(secretMode() === "set" ? "secretValue" : "commands");
      return;
    }
    if (destroySelected() && key.name === "tab") {
      key.preventDefault();
      focusNextFormPane();
      return;
    }
    if (
      secretsSelected() &&
      secretMode() === "set" &&
      focusPane() === "secretValue"
    ) {
      if (key.ctrl && key.name === "c") {
        renderer.destroy();
        return;
      }
      key.preventDefault();
      if (key.name === "enter" || key.name === "return") {
        if (!running()) {
          runCommand(selectedIndex());
        }
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setSecretValue((value) => value.slice(0, -1));
        return;
      }
      if (key.ctrl && key.name === "u") {
        setSecretValue("");
        return;
      }
      if (!key.ctrl && !key.meta && key.sequence.length === 1) {
        setSecretValue((value) => `${value}${key.sequence}`);
      }
      return;
    }
    if (key.name === "escape" && focusPane() !== "commands") {
      key.preventDefault();
      setFocusPane("commands");
      return;
    }
    if (
      (key.ctrl && key.name === "c") ||
      key.name === "q" ||
      key.name === "escape"
    ) {
      key.preventDefault();
      renderer.destroy();
    }
  });

  return (
    <box
      style={{
        height: "100%",
        width: "100%",
        backgroundColor: "#0b0f14",
        padding: 1,
        flexDirection: "column",
      }}
    >
      <box style={{ flexDirection: "row", height: 3, marginBottom: 1 }}>
        <box style={{ flexGrow: 1 }}>
          <text style={{ fg: "#f4f7fb" }}>Hermes Ambit</text>
          <text style={{ fg: "#8aa0b4" }}>
            {`profile ${activeProfileName()} / ${providerLabel(activeProvider())} / ${activeDeploymentLabel()}`}
          </text>
        </box>
        <box style={{ width: 18, alignItems: "flex-end" }}>
          <text style={{ fg: "#7dd3fc" }}>TUI</text>
        </box>
      </box>

      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box
          title="Commands"
          style={{
            border: true,
            borderStyle: "single",
            borderColor: "#223244",
            focusedBorderColor: "#7dd3fc",
            width: 34,
            marginRight: 1,
          }}
        >
          <select
            focused={focusPane() === "commands"}
            options={commands.map((command, index) => ({
              name:
                pendingConfirmation()?.index === index
                  ? `Confirm ${command.name}`
                  : command.name,
              description: command.command,
              value: index,
            }))}
            onChange={(index) => {
              if (pendingConfirmation()?.index !== index) {
                setPendingConfirmation(undefined);
              }
              setSelectedIndex(index);
              setFocusPane("commands");
            }}
            onSelect={(index) => {
              setSelectedIndex(index);
              if (!running()) {
                runCommand(index);
              }
            }}
            showScrollIndicator
            wrapSelection
            style={{
              height: "100%",
              backgroundColor: "transparent",
              focusedBackgroundColor: "transparent",
              selectedBackgroundColor: "#153247",
              selectedTextColor: "#f8fafc",
              descriptionColor: "#8aa0b4",
            }}
          />
        </box>

        <box
          title={selectedCommand().name}
          style={{
            border: true,
            borderStyle: "single",
            borderColor: "#263241",
            flexDirection: "column",
            flexGrow: 1,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text style={{ fg: "#e5edf6" }}>{selectedCommand().command}</text>
          <text style={{ fg: "#9fb3c8" }}>{selectedCommand().scope}</text>
          <text style={{ fg: "#d4dde8", marginTop: 1 }}>
            {selectedCommand().detail}
          </text>
          <text style={{ fg: "#fbbf24", marginTop: 1 }}>
            {selectedCommandExample()}
          </text>

          <text style={{ fg: "#7dd3fc", marginTop: 2 }}>Target</text>
          <text style={{ fg: "#d4dde8" }}>{selectedTargetText()}</text>
          {profileError() ? (
            <text style={{ fg: "#f87171", marginTop: 1 }}>
              {profileError()?.message}
            </text>
          ) : null}

          {setupSelected() ? (
            <>
              <text style={{ fg: "#7dd3fc", marginTop: 2 }}>Setup draft</text>
              <text style={{ fg: "#d4dde8" }}>{selectedSetupStatusText()}</text>
              <box style={{ flexDirection: "row", height: 9, marginTop: 1 }}>
                <box
                  style={{
                    width: 34,
                    marginRight: 1,
                    border: true,
                    borderStyle: "single",
                    borderColor: "#263241",
                    focusedBorderColor: "#7dd3fc",
                  }}
                >
                  <select
                    focused={focusPane() === "setupFields"}
                    options={setupFieldOptions()}
                    onChange={(index) => {
                      setSetupFieldIndex(index);
                    }}
                    onSelect={(index) => {
                      setSetupFieldIndex(index);
                      setFocusPane("setupValue");
                    }}
                    showScrollIndicator
                    wrapSelection
                    style={{
                      height: "100%",
                      backgroundColor: "transparent",
                      focusedBackgroundColor: "transparent",
                      selectedBackgroundColor: "#153247",
                      selectedTextColor: "#f8fafc",
                      descriptionColor: "#8aa0b4",
                    }}
                  />
                </box>
                <box style={{ flexDirection: "column", flexGrow: 1 }}>
                  <text style={{ fg: "#e5edf6" }}>
                    {selectedSetupField()?.label ?? "Field"}
                  </text>
                  <input
                    focused={focusPane() === "setupValue"}
                    value={selectedSetupField()?.value ?? ""}
                    placeholder="not set"
                    onChange={updateSetupField}
                    onSubmit={() => {
                      setFocusPane("setupFields");
                    }}
                    style={{
                      marginTop: 1,
                      backgroundColor: "#111827",
                      textColor: "#f8fafc",
                      focusedBackgroundColor: "#153247",
                      focusedTextColor: "#f8fafc",
                      placeholderColor: "#8aa0b4",
                    }}
                  />
                </box>
              </box>
            </>
          ) : null}

          <text style={{ fg: "#7dd3fc", marginTop: 2 }}>Hermes config</text>
          <text style={{ fg: "#d4dde8" }}>{selectedConfigText()}</text>
          {configSelected() ? (
            <box
              style={{
                flexDirection: "row",
                height: configEndpointSelected() ? 12 : 8,
                marginTop: 1,
              }}
            >
              <box
                style={{
                  width: 34,
                  marginRight: 1,
                  border: true,
                  borderStyle: "single",
                  borderColor: "#263241",
                  focusedBorderColor: "#7dd3fc",
                }}
              >
                <select
                  focused={focusPane() === "configKeys"}
                  options={configKeyOptions()}
                  onChange={(index) => {
                    setConfigKeyIndex(index);
                  }}
                  onSelect={(index) => {
                    setConfigKeyIndex(index);
                    setFocusPane("configValue");
                  }}
                  showScrollIndicator
                  wrapSelection
                  style={{
                    height: "100%",
                    backgroundColor: "transparent",
                    focusedBackgroundColor: "transparent",
                    selectedBackgroundColor: "#153247",
                    selectedTextColor: "#f8fafc",
                    descriptionColor: "#8aa0b4",
                  }}
                />
              </box>
              <box style={{ flexDirection: "column", flexGrow: 1 }}>
                <text style={{ fg: "#e5edf6" }}>
                  {configKeyLabels[selectedConfigKey()]}
                </text>
                <input
                  focused={focusPane() === "configValue"}
                  value={configValue()}
                  placeholder="show current config"
                  onChange={setConfigValue}
                  onSubmit={() => {
                    setFocusPane(
                      configEndpointSelected()
                        ? "configEndpoint"
                        : "configKeys",
                    );
                  }}
                  style={{
                    marginTop: 1,
                    backgroundColor: "#111827",
                    textColor: "#f8fafc",
                    focusedBackgroundColor: "#153247",
                    focusedTextColor: "#f8fafc",
                    placeholderColor: "#8aa0b4",
                  }}
                />
                {configEndpointSelected() ? (
                  <>
                    <text style={{ fg: "#e5edf6", marginTop: 1 }}>
                      Foundry endpoint
                    </text>
                    <input
                      focused={focusPane() === "configEndpoint"}
                      value={configEndpoint()}
                      placeholder={
                        activeAzureModelEndpoint() ??
                        "https://resource.openai.azure.com"
                      }
                      onChange={setConfigEndpoint}
                      onSubmit={() => {
                        setFocusPane("configKeys");
                      }}
                      style={{
                        marginTop: 1,
                        backgroundColor: "#111827",
                        textColor: "#f8fafc",
                        focusedBackgroundColor: "#153247",
                        focusedTextColor: "#f8fafc",
                        placeholderColor: "#8aa0b4",
                      }}
                    />
                  </>
                ) : null}
              </box>
            </box>
          ) : null}
          {secretsSelected() ? (
            <box
              style={{
                flexDirection: "row",
                height: secretMode() === "set" ? 9 : 5,
                marginTop: 1,
              }}
            >
              <box
                style={{
                  width: 22,
                  marginRight: 1,
                  border: true,
                  borderStyle: "single",
                  borderColor: "#263241",
                  focusedBorderColor: "#7dd3fc",
                }}
              >
                <select
                  focused={focusPane() === "secretMode"}
                  options={secretModeOptions()}
                  onChange={(index) => {
                    selectSecretMode(index);
                  }}
                  onSelect={(index) => {
                    const mode = selectSecretMode(index);
                    if (mode) {
                      setFocusPane(mode === "list" ? "commands" : "secretName");
                    }
                  }}
                  showScrollIndicator={false}
                  wrapSelection
                  style={{
                    height: "100%",
                    backgroundColor: "transparent",
                    focusedBackgroundColor: "transparent",
                    selectedBackgroundColor: "#153247",
                    selectedTextColor: "#f8fafc",
                    descriptionColor: "#8aa0b4",
                  }}
                />
              </box>
              <box style={{ flexDirection: "column", flexGrow: 1 }}>
                {secretMode() === "list" ? (
                  <>
                    <text style={{ fg: "#e5edf6" }}>Runtime secrets</text>
                    <text style={{ fg: "#d4dde8", marginTop: 1 }}>
                      {secretModeLabels[secretMode()]}
                    </text>
                  </>
                ) : (
                  <>
                    <text style={{ fg: "#e5edf6" }}>Secret name</text>
                    <input
                      focused={focusPane() === "secretName"}
                      value={secretName()}
                      placeholder={runtimeSecretNamePlaceholder(
                        activeProvider(),
                      )}
                      onChange={setSecretName}
                      onSubmit={() => {
                        setFocusPane(
                          secretMode() === "set" ? "secretValue" : "commands",
                        );
                      }}
                      style={{
                        marginTop: 1,
                        backgroundColor: "#111827",
                        textColor: "#f8fafc",
                        focusedBackgroundColor: "#153247",
                        focusedTextColor: "#f8fafc",
                        placeholderColor: "#8aa0b4",
                      }}
                    />
                    {secretMode() === "set" ? (
                      <>
                        <text style={{ fg: "#e5edf6", marginTop: 1 }}>
                          Secret value
                        </text>
                        <box
                          focused={focusPane() === "secretValue"}
                          style={{
                            marginTop: 1,
                            border: true,
                            borderStyle: "single",
                            borderColor: "#263241",
                            focusedBorderColor: "#7dd3fc",
                            paddingLeft: 1,
                          }}
                        >
                          <text
                            style={{
                              fg:
                                secretValue().length > 0
                                  ? "#f8fafc"
                                  : "#8aa0b4",
                            }}
                          >
                            {secretValueText()}
                          </text>
                        </box>
                      </>
                    ) : null}
                  </>
                )}
              </box>
            </box>
          ) : null}
          {destroySelected() ? (
            <box
              style={{
                flexDirection: "column",
                height: destroyState() === "purge" ? 10 : 5,
                marginTop: 1,
              }}
            >
              <text style={{ fg: "#e5edf6" }}>State</text>
              <select
                focused={focusPane() === "destroyState"}
                options={destroyStateOptions()}
                onChange={(index) => {
                  const state = destroyStates[index];
                  if (state) {
                    setDestroyState(state);
                    setDestroyConfirmation("");
                    setPendingConfirmation(undefined);
                  }
                }}
                onSelect={(index) => {
                  const state = destroyStates[index];
                  if (state) {
                    setDestroyState(state);
                    setDestroyConfirmation("");
                    setPendingConfirmation(undefined);
                  }
                  setFocusPane(
                    state === "purge" ? "destroyConfirm" : "commands",
                  );
                }}
                showScrollIndicator={false}
                wrapSelection
                style={{
                  height: 3,
                  backgroundColor: "transparent",
                  focusedBackgroundColor: "transparent",
                  selectedBackgroundColor: "#153247",
                  selectedTextColor: "#f8fafc",
                  descriptionColor: "#8aa0b4",
                }}
              />
              <text style={{ fg: "#d4dde8" }}>
                {destroyStateLabels[destroyState()]}
              </text>
              {destroyState() === "purge" ? (
                <>
                  <text style={{ fg: "#e5edf6", marginTop: 1 }}>
                    Purge confirmation
                  </text>
                  <input
                    focused={focusPane() === "destroyConfirm"}
                    value={destroyConfirmation()}
                    placeholder={activeDeploymentName() ?? "deployment name"}
                    onChange={setDestroyConfirmation}
                    onSubmit={() => {
                      setFocusPane("commands");
                    }}
                    style={{
                      marginTop: 1,
                      backgroundColor: "#111827",
                      textColor: "#f8fafc",
                      focusedBackgroundColor: "#153247",
                      focusedTextColor: "#f8fafc",
                      placeholderColor: "#8aa0b4",
                    }}
                  />
                </>
              ) : null}
            </box>
          ) : null}

          <text style={{ fg: "#7dd3fc", marginTop: 2 }}>Result</text>
          <text style={{ fg: running() ? "#fbbf24" : "#d4dde8" }}>
            {output()}
          </text>
        </box>
      </box>
    </box>
  );
};

export const runTui = (
  intent: Extract<CommandIntent, { readonly command: "tui" }>,
  runtime: CommandRuntime,
): Promise<void> =>
  new Promise((resolve, reject) => {
    render(
      () => (
        <TuiApp
          context={tuiLaunchContext(intent, runtime)}
          globals={intent.globals}
          runtime={runtime}
        />
      ),
      {
        targetFps: 30,
        exitOnCtrlC: false,
        onDestroy: resolve,
      },
    ).catch(reject);
  });
