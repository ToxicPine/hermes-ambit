import type {
  AppError,
  AuthMode,
  ColorMode,
  CommandIntent,
  CommandName,
  GlobalOptions,
  OutputMode,
  ParsedCommand,
  ProviderKind,
  SecretInputSource,
} from "./types.js";
import { commandMustNotPrompt } from "./types.js";
import { validateDeploymentName } from "./app-profile.js";
import {
  draftFromArgs,
  invalidProviderFieldValues,
  invalidProviderFields,
  isProviderField,
  missingGcpStatePathFields,
  providerFieldAllowedValues,
  providerFieldProviders,
  validateDraft,
} from "./setup-state.js";

type TokenCursor = {
  readonly tokens: readonly string[];
  index: number;
};

const flagValue = (
  cursor: TokenCursor,
  flag: string,
): string | AppError => {
  const value = cursor.tokens[cursor.index + 1];
  if (!value || value.startsWith("--")) {
    return {
      code: "args.missing",
      message: `Missing value for ${flag}.`,
    };
  }
  cursor.index += 1;
  return value;
};

const isProvider = (value: string): value is ProviderKind =>
  value === "gcp" || value === "azure";

const isAuthMode = (value: string): value is AuthMode =>
  value === "auto" || value === "browser" || value === "device";

const isColorMode = (value: string): value is ColorMode =>
  value === "auto" || value === "always" || value === "never";

const errorResult = (
  command: CommandName,
  error: AppError,
  outputMode: OutputMode = "cli",
): ParsedCommand => ({
  ok: false,
  outputMode,
  result: {
    ok: false,
    command,
    error,
  },
});

const defaultGlobals = (): GlobalOptions => ({
  outputMode: "cli",
  inputMode: "interactive",
  noBrowser: false,
  debug: false,
  color: "auto",
  providerFields: {},
});

const providerFieldNameFromFlag = (token: string): string | undefined => {
  const field = token.startsWith("--") ? token.slice(2) : undefined;
  return field && isProviderField(field) ? field : undefined;
};

const parseGlobals = (
  cursor: TokenCursor,
):
  | { readonly globals: GlobalOptions; readonly rest: readonly string[] }
  | AppError => {
  const globals: {
    profile?: string;
    deployment?: string;
    provider?: ProviderKind;
    config?: string;
    outputMode: GlobalOptions["outputMode"];
    inputMode: GlobalOptions["inputMode"];
    noBrowser: boolean;
    auth?: AuthMode;
    debug: boolean;
    color: ColorMode;
    colorExplicit?: boolean;
    providerFields: Record<string, string>;
  } = defaultGlobals();
  const rest: string[] = [];

  while (cursor.index < cursor.tokens.length) {
    const token = cursor.tokens[cursor.index];
    if (!token) {
      cursor.index += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      rest.push(token);
      cursor.index += 1;
      continue;
    }

    switch (token) {
      case "--profile": {
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        globals.profile = value;
        break;
      }
      case "--deployment": {
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        globals.deployment = value;
        break;
      }
      case "--provider": {
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        if (!isProvider(value)) {
          return {
            code: "provider.invalid",
            message: "--provider must be gcp or azure.",
          };
        }
        globals.provider = value;
        break;
      }
      case "--config": {
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        globals.config = value;
        break;
      }
      case "--json":
        globals.outputMode = "json";
        globals.inputMode = "nonInteractive";
        globals.color = "never";
        globals.noBrowser = true;
        break;
      case "--no-input":
        globals.inputMode = "nonInteractive";
        globals.noBrowser = true;
        break;
      case "--no-browser":
        globals.noBrowser = true;
        break;
      case "--auth": {
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        if (!isAuthMode(value)) {
          return {
            code: "args.invalid",
            message: "--auth must be auto, browser, or device.",
          };
        }
        globals.auth = value;
        break;
      }
      case "--debug":
        globals.debug = true;
        break;
      case "--color": {
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        if (!isColorMode(value)) {
          return {
            code: "args.invalid",
            message: "--color must be auto, always, or never.",
          };
        }
        globals.color = value;
        globals.colorExplicit = true;
        break;
      }
      default: {
        const providerField = providerFieldNameFromFlag(token);
        if (!providerField) {
          rest.push(token);
          break;
        }
        const value = flagValue(cursor, token);
        if (typeof value !== "string") return value;
        globals.providerFields[providerField] = value;
        break;
      }
    }
    cursor.index += 1;
  }

  if (globals.outputMode === "json") {
    globals.inputMode = "nonInteractive";
    globals.noBrowser = true;
    globals.color = "never";
  }

  return { globals, rest };
};

const commandError = (message: string): AppError => ({
  code: "args.invalid",
  message,
});

type FlagShape = {
  readonly kind: "boolean" | "value";
};

type ParsedFlagValue = true | string;

type ParsedShapeArgs = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, ParsedFlagValue>>;
};

type CommandShape = {
  readonly path: readonly string[];
  readonly command: CommandName;
  readonly positionals: {
    readonly min: number;
    readonly max: number;
    readonly labels: readonly string[];
  };
  readonly flags: Readonly<Record<string, FlagShape>>;
  readonly exclusiveFlags?: readonly (readonly string[])[];
  readonly build: (
    globals: GlobalOptions,
    args: ParsedShapeArgs,
  ) => CommandIntent;
};

type BuildIntentResult =
  | { readonly ok: true; readonly intent: CommandIntent }
  | {
      readonly ok: false;
      readonly command: CommandName;
      readonly error: AppError;
    };

const booleanFlag = (args: ParsedShapeArgs, flag: string): boolean =>
  args.flags[flag] === true;

const stringFlag = (
  args: ParsedShapeArgs,
  flag: string,
): string | undefined => {
  const value = args.flags[flag];
  return typeof value === "string" ? value : undefined;
};

const secretSourceFromArgs = (args: ParsedShapeArgs): SecretInputSource => {
  const envName = stringFlag(args, "--from-env");
  if (envName) return { type: "env", name: envName };
  if (booleanFlag(args, "--value-stdin")) return { type: "stdin" };
  return { type: "prompt" };
};

const commandShapes = [
  {
    path: ["tui"],
    command: "tui",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({
      command: "tui",
      globals: {
        ...globals,
        outputMode: globals.outputMode === "json" ? "json" : "tui",
      },
      explicit: true,
    }),
  },
  {
    path: ["setup"],
    command: "setup",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {
      "--quick": { kind: "boolean" },
      "--reset": { kind: "boolean" },
      "--reconfigure": { kind: "boolean" },
    },
    exclusiveFlags: [["--quick", "--reset", "--reconfigure"]],
    build: (globals, args) => ({
      command: "setup",
      globals,
      quick: booleanFlag(args, "--quick"),
      reset: booleanFlag(args, "--reset"),
      reconfigure: booleanFlag(args, "--reconfigure"),
    }),
  },
  {
    path: ["auth", "check"],
    command: "auth.check",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "auth.check", globals }),
  },
  {
    path: ["discover"],
    command: "discover",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "discover", globals }),
  },
  {
    path: ["models"],
    command: "models.list",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "models.list", globals }),
  },
  {
    path: ["models", "list"],
    command: "models.list",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "models.list", globals }),
  },
  {
    path: ["deploy"],
    command: "deploy",
    positionals: { min: 0, max: 0, labels: [] },
    flags: { "--yes": { kind: "boolean" } },
    build: (globals, args) => ({
      command: "deploy",
      globals,
      yes: booleanFlag(args, "--yes"),
    }),
  },
  {
    path: ["status"],
    command: "status",
    positionals: { min: 0, max: 0, labels: [] },
    flags: { "--watch": { kind: "boolean" } },
    build: (globals, args) => ({
      command: "status",
      globals,
      watch: booleanFlag(args, "--watch"),
    }),
  },
  {
    path: ["restart"],
    command: "restart",
    positionals: { min: 0, max: 0, labels: [] },
    flags: { "--yes": { kind: "boolean" } },
    build: (globals, args) => ({
      command: "restart",
      globals,
      yes: booleanFlag(args, "--yes"),
    }),
  },
  {
    path: ["destroy"],
    command: "destroy",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {
      "--yes": { kind: "boolean" },
      "--retain-state": { kind: "boolean" },
      "--purge-state": { kind: "boolean" },
    },
    exclusiveFlags: [["--retain-state", "--purge-state"]],
    build: (globals, args) => {
      const retain = booleanFlag(args, "--retain-state");
      const purge = booleanFlag(args, "--purge-state");
      return {
        command: "destroy",
        globals,
        yes: booleanFlag(args, "--yes"),
        ...(retain || purge ? { state: retain ? "retain" : "purge" } : {}),
      };
    },
  },
  {
    path: ["doctor"],
    command: "doctor",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "doctor", globals }),
  },
  {
    path: ["config"],
    command: "config.show",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "config.show", globals }),
  },
  {
    path: ["config", "show"],
    command: "config.show",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "config.show", globals }),
  },
  {
    path: ["config", "set"],
    command: "config.set",
    positionals: { min: 2, max: 2, labels: ["<key>", "<value>"] },
    flags: {},
    build: (globals, args) => ({
      command: "config.set",
      globals,
      key: args.positionals[0]!,
      value: args.positionals[1]!,
    }),
  },
  {
    path: ["secrets"],
    command: "secrets.list",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "secrets.list", globals }),
  },
  {
    path: ["secrets", "list"],
    command: "secrets.list",
    positionals: { min: 0, max: 0, labels: [] },
    flags: {},
    build: (globals) => ({ command: "secrets.list", globals }),
  },
  {
    path: ["secrets", "set"],
    command: "secrets.set",
    positionals: { min: 1, max: 1, labels: ["<name>"] },
    flags: {
      "--value-stdin": { kind: "boolean" },
      "--from-env": { kind: "value" },
    },
    exclusiveFlags: [["--value-stdin", "--from-env"]],
    build: (globals, args) => ({
      command: "secrets.set",
      globals,
      name: args.positionals[0]!,
      source: secretSourceFromArgs(args),
    }),
  },
  {
    path: ["secrets", "delete"],
    command: "secrets.delete",
    positionals: { min: 1, max: 1, labels: ["<name>"] },
    flags: {},
    build: (globals, args) => ({
      command: "secrets.delete",
      globals,
      name: args.positionals[0]!,
    }),
  },
] satisfies readonly CommandShape[];

const commandLabel = (shape: CommandShape): string => shape.path.join(" ");

const positionalLabel = (shape: CommandShape): string =>
  shape.positionals.labels.join(" and ");

const unexpectedArgument = (shape: CommandShape, token: string): AppError =>
  commandError(`Unexpected argument for ${commandLabel(shape)}: ${token}.`);

const selectCommandShape = (rest: readonly string[]): CommandShape | AppError => {
  const tokens = rest.length > 0 ? rest : ["tui"];
  const matches = commandShapes
    .filter((shape) => shape.path.every((part, index) => tokens[index] === part))
    .sort((left, right) => right.path.length - left.path.length);
  const match = matches[0];

  if (!match) {
    return commandError(`Unknown command: ${tokens[0] ?? "tui"}.`);
  }

  return match;
};

const parseShapeArgs = (
  shape: CommandShape,
  tokens: readonly string[],
): ParsedShapeArgs | AppError => {
  const positionals: string[] = [];
  const flags: Record<string, ParsedFlagValue> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (!token.startsWith("--")) {
      if (positionals.length >= shape.positionals.max) {
        return unexpectedArgument(shape, token);
      }
      positionals.push(token);
      continue;
    }

    const flag = shape.flags[token];
    if (!flag) {
      return unexpectedArgument(shape, token);
    }
    if (flags[token] !== undefined) {
      return commandError(
        `${commandLabel(shape)} received ${token} more than once.`,
      );
    }
    if (flag.kind === "boolean") {
      flags[token] = true;
      continue;
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      return {
        code: "args.missing",
        message: `Missing value for ${token}.`,
      };
    }
    flags[token] = value;
    index += 1;
  }

  if (positionals.length < shape.positionals.min) {
    return commandError(
      `${commandLabel(shape)} requires ${positionalLabel(shape)}.`,
    );
  }

  for (const group of shape.exclusiveFlags ?? []) {
    const selected = group.filter((flag) => flags[flag] !== undefined);
    if (selected.length > 1) {
      return commandError(
        `${commandLabel(shape)} accepts only one of ${group.join(", ")}.`,
      );
    }
  }

  return { positionals, flags };
};

const buildIntent = (
  globals: GlobalOptions,
  rest: readonly string[],
): BuildIntentResult => {
  const shape = selectCommandShape(rest);
  if ("code" in shape) {
    return { ok: false, command: "tui", error: shape };
  }

  const tokens = rest.length > 0 ? rest : ["tui"];
  const parsedArgs = parseShapeArgs(shape, tokens.slice(shape.path.length));
  if ("code" in parsedArgs) {
    return { ok: false, command: shape.command, error: parsedArgs };
  }

  const intent = shape.build(globals, parsedArgs);
  return {
    ok: true,
    intent:
      intent.command === "tui" && rest.length === 0
        ? { ...intent, explicit: false }
        : intent,
  };
};

const providerText = (providers: readonly ProviderKind[]): string =>
  providers.join(" or ");

const confirmedInJson = (intent: CommandIntent): boolean =>
  (intent.command === "deploy" ||
    intent.command === "restart" ||
    intent.command === "destroy") &&
  intent.globals.outputMode === "json" &&
  intent.yes;

type InputRequirementMode = "JSON mode" | "--no-input";

const missingProviderInput = (mode: InputRequirementMode): AppError =>
  commandError(`${mode} requires --provider unless --profile or --config supplies a target.`);

const missingDeploymentInput = (mode: InputRequirementMode): AppError =>
  commandError(`${mode} requires --deployment unless --profile or --config supplies a target.`);

const missingProviderFieldInput = (
  mode: InputRequirementMode,
  provider: ProviderKind,
  field: string,
): AppError =>
  commandError(
    `${mode} requires --${field} for ${provider} unless --profile or --config supplies a target.`,
  );

const requireProviderFields = (
  mode: InputRequirementMode,
  globals: GlobalOptions,
  fields: readonly string[],
): AppError | undefined => {
  const provider = globals.provider;
  if (!provider) return missingProviderInput(mode);

  const missing = fields.find((field) => !globals.providerFields[field]);
  return missing ? missingProviderFieldInput(mode, provider, missing) : undefined;
};

const requireAuthTarget = (
  mode: InputRequirementMode,
  globals: GlobalOptions,
): AppError | undefined => {
  if (globals.profile || globals.config) return undefined;
  if (!globals.provider) return missingProviderInput(mode);
  return globals.provider === "azure"
    ? requireProviderFields(mode, globals, ["tenant", "subscription"])
    : undefined;
};

const requireDiscoveryTarget = (
  mode: InputRequirementMode,
  globals: GlobalOptions,
): AppError | undefined => {
  if (globals.profile || globals.config) return undefined;
  if (!globals.provider) return missingProviderInput(mode);
  return globals.provider === "gcp"
    ? requireProviderFields(mode, globals, ["project", "region"])
    : requireProviderFields(mode, globals, [
        "tenant",
        "subscription",
        "resource-group",
      ]);
};

const requireModelTarget = (
  mode: InputRequirementMode,
  globals: GlobalOptions,
): AppError | undefined => {
  if (globals.profile || globals.config) return undefined;
  if (!globals.provider) return missingProviderInput(mode);
  return globals.provider === "gcp"
    ? requireProviderFields(mode, globals, ["region"])
    : requireProviderFields(mode, globals, ["tenant", "endpoint"]);
};

const requireDeploymentTarget = (
  mode: InputRequirementMode,
  globals: GlobalOptions,
): AppError | undefined => {
  if (globals.profile || globals.config) return undefined;
  if (!globals.provider) return missingProviderInput(mode);
  if (!globals.deployment) return missingDeploymentInput(mode);
  return globals.provider === "gcp"
    ? requireProviderFields(mode, globals, ["project", "region"])
    : requireProviderFields(mode, globals, [
        "tenant",
        "subscription",
        "resource-group",
      ]);
};

const requireDeploymentSpec = (
  mode: InputRequirementMode,
  globals: GlobalOptions,
): AppError | undefined => {
  const refError = requireDeploymentTarget(mode, globals);
  if (refError) return refError;

  const provider = globals.provider;
  if (!provider) return missingProviderInput(mode);

  if (provider === "gcp") {
    const stateServerError = requireProviderFields(mode, globals, ["state-server"]);
    if (stateServerError) return stateServerError;

    const fields = globals.providerFields;
    if (missingGcpStatePathFields(fields).length > 0) {
      return commandError(
        `${mode} requires --state-path or both --state-data-path and --state-nix-path for gcp unless --profile or --config supplies a target.`,
      );
    }
    return undefined;
  }

  return requireProviderFields(mode, globals, [
    "location",
    "environment-id",
    "storage-name",
  ]);
};

const requireCommandInput = (
  intent: CommandIntent,
  mode: InputRequirementMode,
): AppError | undefined => {
  switch (intent.command) {
    case "auth.check":
      return requireAuthTarget(mode, intent.globals);
    case "discover":
      return requireDiscoveryTarget(mode, intent.globals);
    case "models.list":
      return requireModelTarget(mode, intent.globals);
    case "deploy":
    case "config.set":
      return requireDeploymentSpec(mode, intent.globals);
    case "config.show":
      return intent.globals.provider === "azure"
        ? requireDeploymentSpec(mode, intent.globals)
        : requireDeploymentTarget(mode, intent.globals);
    case "destroy":
      return intent.state === "purge"
        ? requireDeploymentSpec(mode, intent.globals)
        : requireDeploymentTarget(mode, intent.globals);
    case "status":
    case "secrets.list":
    case "secrets.set":
    case "secrets.delete":
    case "restart":
      return requireDeploymentTarget(mode, intent.globals);
    case "tui":
    case "setup":
    case "doctor":
      return undefined;
  }
};

const requireJsonExplicitInput = (
  intent: CommandIntent,
): AppError | undefined =>
  intent.globals.outputMode === "json"
    ? requireCommandInput(intent, "JSON mode")
    : undefined;

export const validateResolvedCommandInput = (
  intent: CommandIntent,
): AppError | undefined =>
  intent.globals.inputMode === "nonInteractive" &&
  intent.globals.outputMode !== "json"
    ? requireCommandInput(intent, "--no-input")
    : undefined;

const requireNonInteractiveSetupInput = (
  intent: Extract<CommandIntent, { readonly command: "setup" }>,
): AppError | undefined => {
  if (
    intent.reset ||
    intent.globals.inputMode !== "nonInteractive" ||
    intent.globals.config
  ) {
    return undefined;
  }

  const errors = validateDraft(
    draftFromArgs({
      ...(intent.globals.profile ? { profile: intent.globals.profile } : {}),
      ...(intent.globals.provider ? { provider: intent.globals.provider } : {}),
      ...(intent.globals.deployment
        ? { deployment: intent.globals.deployment }
        : {}),
      fields: intent.globals.providerFields,
    }),
  );
  return errors[0];
};

const validateProviderFields = (
  globals: GlobalOptions,
): AppError | undefined => {
  const fields = Object.keys(globals.providerFields);
  const provider = globals.provider;
  const unsupportedField = provider
    ? invalidProviderFields(provider, globals.providerFields)[0]
    : undefined;
  if (unsupportedField && provider) {
    const supportedProviders = providerFieldProviders(unsupportedField) ?? [];
    return commandError(
      `--${unsupportedField} is only valid with --provider ${providerText(
        supportedProviders,
      )}.`,
    );
  }

  const providerSpecificFields = fields.filter(
    (field) => providerFieldProviders(field)?.length === 1,
  );
  const requestedProviders = new Set(
    providerSpecificFields.flatMap(
      (field) => providerFieldProviders(field) ?? [],
    ),
  );
  if (
    !globals.provider &&
    requestedProviders.has("gcp") &&
    requestedProviders.has("azure")
  ) {
    return commandError(
      "GCP and Azure provider arguments cannot be combined without --provider.",
    );
  }

  if (provider) {
    const invalidValueField = invalidProviderFieldValues(
      provider,
      globals.providerFields,
    )[0];
    if (invalidValueField) {
      const allowed =
        providerFieldAllowedValues(provider, invalidValueField) ?? [];
      return commandError(
        `--${invalidValueField} for ${provider} must be ${allowed.join(" or ")}.`,
      );
    }
  }

  return undefined;
};

export const validateIntent = (intent: CommandIntent): AppError | undefined => {
  const providerError = validateProviderFields(intent.globals);
  if (providerError) return providerError;

  if (intent.globals.deployment) {
    const deploymentError = validateDeploymentName(intent.globals.deployment);
    if (deploymentError) return deploymentError;
  }

  if (intent.command === "tui") {
    if (intent.globals.outputMode === "json") {
      return commandError("TUI mode cannot be combined with --json.");
    }
    if (intent.globals.inputMode === "nonInteractive") {
      return commandError("TUI mode requires interactive input.");
    }
    if (intent.globals.noBrowser) {
      return commandError("TUI mode cannot be combined with --no-browser.");
    }
    if (intent.globals.colorExplicit) {
      return commandError("TUI mode cannot be combined with --color.");
    }
  }

  if (intent.globals.outputMode === "json") {
    if (confirmedInJson(intent)) {
      return commandError(
        "--yes is only valid for human CLI confirmation; JSON commands are already explicit.",
      );
    }
    if (intent.command === "setup") {
      return commandError(
        "setup does not support --json; use setup --no-input for readable automation.",
      );
    }
    if (intent.command === "status" && intent.watch) {
      return commandError("status --watch does not support --json.");
    }
    if (intent.command === "secrets.set" && intent.source?.type === "prompt") {
      return commandError(
        "secrets set --json requires --value-stdin or --from-env <name>.",
      );
    }
    const inputError = requireJsonExplicitInput(intent);
    if (inputError) return inputError;
  }

  if (
    intent.globals.provider === "gcp" &&
    intent.globals.auth &&
    intent.globals.auth !== "auto"
  ) {
    return commandError(
      "GCP auth currently uses Application Default Credentials; use --auth auto or omit --auth.",
    );
  }

  if (
    commandMustNotPrompt(intent) &&
    (intent.globals.auth === "browser" || intent.globals.auth === "device")
  ) {
    return commandError(
      `${intent.command} does not support interactive auth; run auth check with --auth ${intent.globals.auth} first, or use --auth auto.`,
    );
  }

  if (
    intent.globals.inputMode === "nonInteractive" &&
    intent.globals.auth === "browser"
  ) {
    return commandError("--auth browser requires interactive input.");
  }
  if (
    intent.globals.inputMode === "nonInteractive" &&
    intent.globals.auth === "device"
  ) {
    return commandError("--auth device requires interactive input.");
  }
  if (intent.globals.noBrowser && intent.globals.auth === "browser") {
    return commandError("--auth browser cannot be combined with --no-browser.");
  }

  if (intent.command === "setup") {
    const inputError = requireNonInteractiveSetupInput(intent);
    if (inputError) return inputError;
  }

  if (intent.command === "secrets.set") {
    if (
      intent.globals.inputMode === "nonInteractive" &&
      intent.source?.type === "prompt"
    ) {
      return commandError(
        "secrets set --no-input requires --value-stdin or --from-env <name>.",
      );
    }
  }

  if (
    intent.command === "destroy" &&
    intent.globals.outputMode === "json" &&
    !intent.state
  ) {
    return commandError(
      "destroy --json requires --retain-state or --purge-state.",
    );
  }
  if (
    intent.command === "destroy" &&
    intent.globals.outputMode !== "json" &&
    intent.yes &&
    !intent.state
  ) {
    return commandError(
      "destroy --yes requires --retain-state or --purge-state.",
    );
  }

  return undefined;
};

export const parseArgs = (argv: readonly string[]): ParsedCommand => {
  const parsed = parseGlobals({ tokens: argv, index: 0 });
  if ("code" in parsed) {
    return errorResult("tui", parsed, argv.includes("--json") ? "json" : "cli");
  }

  const built = buildIntent(parsed.globals, parsed.rest);
  if (!built.ok) {
    return errorResult(built.command, built.error, parsed.globals.outputMode);
  }

  const validationError = validateIntent(built.intent);
  if (validationError) {
    return errorResult(
      built.intent.command,
      validationError,
      built.intent.globals.outputMode,
    );
  }

  return { ok: true, intent: built.intent };
};
