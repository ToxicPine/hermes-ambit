import { stdin as nodeStdin, stderr as nodeStderr } from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";

import {
  parseArgs,
  validateIntent,
  validateResolvedCommandInput,
} from "./args.js";
import {
  runIntent,
  validateRuntime,
  type CommandRuntime,
  type RuntimeInfo,
} from "./command.js";
import { mergeConfigIntoIntent, readDeployerConfig } from "./config-file.js";
import { defaultProfileRoot, makeFileProfileStore } from "./profile-store.js";
import { renderHuman, renderJson } from "./render.js";
import { isProviderField } from "./setup-state.js";
import type {
  AppError,
  CommandName,
  CommandIntent,
  CommandResult,
  OutputMode,
  ProviderKind,
} from "./types.js";

declare const process: {
  readonly argv: readonly string[];
  readonly stdout: {
    readonly isTTY?: boolean;
    readonly write: (chunk: string) => void;
  };
  readonly stdin: {
    readonly isTTY?: boolean;
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode: number | undefined;
};

declare const Bun: {
  readonly stdin: {
    readonly text: () => Promise<string>;
  };
};

type Keypress = {
  readonly sequence?: string;
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
};

const runtimeErrorResult = (
  command: CommandName,
  error: AppError,
): CommandResult => ({
  ok: false,
  command,
  error,
});

const providerFlagValue = (argv: readonly string[]): string | undefined => {
  const providerIndex = argv.indexOf("--provider");
  return providerIndex >= 0 ? argv[providerIndex + 1] : undefined;
};

const providerFromArgv = (argv: readonly string[]): ProviderKind | undefined => {
  const value = providerFlagValue(argv);
  return value === "gcp" || value === "azure" ? value : undefined;
};

const providerMismatchResult = (
  provider: ProviderKind,
  actual: string | undefined,
): CommandResult => ({
  ok: false,
  command: "tui",
  error: {
    code: "provider.invalid",
    message: actual
      ? `This binary is scoped to provider ${provider}, not ${actual}.`
      : "Missing value for --provider.",
  },
});

type ProviderScopedArgv =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly result: CommandResult };

const providerScopedArgv = (
  provider: ProviderKind,
  argv: readonly string[],
): ProviderScopedArgv => {
  const requestedProvider = providerFlagValue(argv);
  if (requestedProvider === undefined && argv.includes("--provider")) {
    return { ok: false, result: providerMismatchResult(provider, undefined) };
  }
  if (requestedProvider && requestedProvider !== provider) {
    return {
      ok: false,
      result: providerMismatchResult(provider, requestedProvider),
    };
  }
  return {
    ok: true,
    argv: requestedProvider ? argv : ["--provider", provider, ...argv],
  };
};

const activeProfileArgv = (
  argv: readonly string[],
  runtime: CommandRuntime,
  blocked: boolean,
  providerScope?: ProviderKind,
): ProviderScopedArgv => {
  if (blocked) {
    return { ok: true, argv };
  }

  const profiles = runtime.profiles;
  if (!profiles) {
    return { ok: true, argv };
  }

  const active = profiles.readActiveProfileName();
  if (!active) {
    return { ok: true, argv };
  }
  if (typeof active !== "string") {
    return { ok: false, result: runtimeErrorResult("tui", active) };
  }

  if (providerScope) {
    const profile = profiles.readProfile(active);
    if ("code" in profile) {
      return { ok: false, result: runtimeErrorResult("tui", profile) };
    }
    if (profile.provider !== providerScope) {
      return { ok: true, argv };
    }
  }

  return { ok: true, argv: ["--profile", active, ...argv] };
};

const outputModeFromArgv = (argv: readonly string[]): OutputMode =>
  argv.includes("--json") ? "json" : "cli";

const renderResult = (
  result: CommandResult,
  outputMode: OutputMode,
): string => (outputMode === "json" ? renderJson(result) : renderHuman(result));

const helpValueFlags = new Set([
  "--profile",
  "--deployment",
  "--provider",
  "--config",
  "--auth",
  "--color",
  "--user",
  "--project",
  "--region",
  "--service-account",
  "--quota-project",
  "--state",
  "--state-server",
  "--state-path",
  "--state-data-path",
  "--state-nix-path",
  "--tenant",
  "--subscription",
  "--resource-group",
  "--location",
  "--environment-id",
  "--storage-name",
  "--endpoint",
]);

const firstPositional = (argv: readonly string[]): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith("-")) return token;
    if (helpValueFlags.has(token)) {
      index += 1;
    }
  }
  return undefined;
};

export const helpRequested = (argv: readonly string[]): boolean =>
  argv.includes("--help") ||
  argv.includes("-h") ||
  firstPositional(argv) === "help";

const helpProvider = (
  provider: ProviderKind | undefined,
  argv: readonly string[],
): ProviderKind | undefined => provider ?? providerFromArgv(argv);

const usageProviderLine = (provider: ProviderKind | undefined): string =>
  provider
    ? `This binary is scoped to --provider ${provider}.`
    : "Use --provider gcp or --provider azure, or use hermes-ambit-gcp / hermes-ambit-azure.";

const usageCommand = (provider: ProviderKind | undefined): string =>
  provider ? `hermes-ambit-${provider}` : "hermes-ambit";

const sharedProviderArgs = `Shared provider args:
  --user <container-user>`;

const gcpProviderArgs = `GCP provider args:
  --project <project-id>
  --region <region>
  --service-account <email>
  --quota-project <project-id>
  --state nfs
  --state-server <host-or-ref>
  --state-path <path>
  --state-data-path <path>
  --state-nix-path <path>`;

const azureProviderArgs = `Azure provider args:
  --tenant <tenant-id>
  --subscription <subscription-id>
  --resource-group <name>
  --location <azure-location>
  --environment-id <managed-environment-resource-id>
  --storage-name <container-app-environment-storage-name>
  --endpoint <azure-openai-compatible-endpoint>
  --state azure-files
  --state-data-path <path>
  --state-nix-path <path>`;

const providerArgsUsage = (provider: ProviderKind | undefined): string => {
  if (provider === "gcp") return `${sharedProviderArgs}\n\n${gcpProviderArgs}`;
  if (provider === "azure") return `${sharedProviderArgs}\n\n${azureProviderArgs}`;
  return `${sharedProviderArgs}\n\n${gcpProviderArgs}\n\n${azureProviderArgs}`;
};

const renderUsage = (
  provider: ProviderKind | undefined,
  providerScope?: ProviderKind,
): string => {
  const command = usageCommand(providerScope);
  return `Usage:
  ${command} setup [--quick|--reset|--reconfigure] [global args] [provider args]
  ${command} auth check [global args]
  ${command} discover [global args]
  ${command} models [list] [global args]
  ${command} deploy [global args] [provider args] [--yes]
  ${command} status [global args] [--watch]
  ${command} config [show|set <key> <value>] [global args]
  ${command} secrets [list|set <name>|delete <name>] [global args]
  ${command} restart [global args] [--yes]
  ${command} destroy [global args] [--retain-state|--purge-state] [--yes]
  ${command} doctor [global args]
  ${command} tui [global args]

Global args:
  --profile <name>
  --deployment <name>
  --provider <gcp|azure>
  --config <path>
  --json
  --no-input
  --no-browser
  --auth <auto|browser|device>
  --debug
  --color <auto|always|never>

${providerArgsUsage(provider)}

${usageProviderLine(providerScope)}
`;
};

const watchIntervalMs = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const readVisibleText = (
  label: string,
  defaultValue?: string,
): Promise<string> => {
  if (!nodeStdin.isTTY) {
    return Promise.reject(new Error("terminal input is not a TTY"));
  }

  const suffix = defaultValue && defaultValue.length > 0
    ? ` [${defaultValue}]`
    : "";

  return new Promise((resolve) => {
    const line = createInterface({
      input: nodeStdin,
      output: nodeStderr,
    });
    line.question(`${label}${suffix}: `, (answer) => {
      line.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : defaultValue ?? "");
    });
  });
};

const readHiddenSecret = (name: string): Promise<string> => {
  if (!nodeStdin.isTTY) {
    return Promise.reject(new Error("terminal input is not a TTY"));
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = nodeStdin.isRaw;

    const cleanup = () => {
      nodeStdin.off("keypress", onKeypress);
      nodeStdin.setRawMode(wasRaw);
      nodeStdin.pause();
    };

    const finish = () => {
      nodeStderr.write("\n");
      cleanup();
      resolve(value);
    };

    const cancel = () => {
      nodeStderr.write("\n");
      cleanup();
      reject(new Error("secret entry was cancelled"));
    };

    const onKeypress = (chunk: string, key: Keypress) => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (key.ctrl && key.name === "u") {
        value = "";
        return;
      }
      if (!key.ctrl && !key.meta && chunk.length > 0) {
        value += chunk;
      }
    };

    emitKeypressEvents(nodeStdin);
    nodeStderr.write(`Enter value for ${name}: `);
    nodeStdin.setRawMode(true);
    nodeStdin.resume();
    nodeStdin.on("keypress", onKeypress);
  });
};

const currentRuntimeInfo = (): RuntimeInfo => ({
  stdinIsTty: process.stdin.isTTY === true,
  stdoutIsTty: process.stdout.isTTY === true,
  stderrIsTty: nodeStderr.isTTY === true,
});

const makeCommandRuntime = (
  runtimeInfo: RuntimeInfo = currentRuntimeInfo(),
): CommandRuntime => ({
  runtimeInfo,
  profiles: makeFileProfileStore({
    rootDir: defaultProfileRoot(process.env),
  }),
  env: process.env,
  promptText: readVisibleText,
  deviceCodePrompt: (message) => {
    nodeStderr.write(`${message}\n`);
  },
  readStdin: () => Bun.stdin.text(),
  readSecret: readHiddenSecret,
});

const statusSnapshotIntent = (
  intent: Extract<CommandIntent, { readonly command: "status" }>,
): Extract<CommandIntent, { readonly command: "status" }> => ({
  ...intent,
  watch: false,
});

const runStatusWatch = async (
  intent: Extract<CommandIntent, { readonly command: "status" }>,
  runtime: CommandRuntime,
): Promise<void> => {
  const snapshot = statusSnapshotIntent(intent);
  for (;;) {
    const result = await runIntent(snapshot, runtime);
    process.stdout.write(renderHuman(result));
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    await sleep(watchIntervalMs);
  }
};

const runTuiIntent = async (
  intent: Extract<CommandIntent, { readonly command: "tui" }>,
  runtime: CommandRuntime,
): Promise<void> => {
  const tui = await import("./tui-app.js");
  await tui.runTui(intent, runtime);
};

const configuredIntent = (intent: CommandIntent): CommandIntent | AppError => {
  const path = intent.globals.config;
  if (!path) return intent;

  const config = readDeployerConfig(path);
  if ("code" in config) return config;

  const merged = mergeConfigIntoIntent(intent, config);
  if ("code" in merged) return merged;
  return validateIntent(merged) ?? merged;
};

const activeProfileIntent = (
  intent: CommandIntent,
  runtime: CommandRuntime,
): CommandIntent | AppError => {
  if (intent.globals.profile) return intent;

  const active = runtime.profiles?.readActiveProfileName();
  if (!active) return intent;
  if (typeof active !== "string") return active;

  return {
    ...intent,
    globals: {
      ...intent.globals,
      profile: active,
    },
  };
};

const hasProviderFieldInput = (globals: CommandIntent["globals"]): boolean =>
  Object.keys(globals.providerFields).length > 0;

export const applyActiveProfileDefault = (
  parsedIntent: CommandIntent,
  configuredIntent: CommandIntent,
  runtime: CommandRuntime,
): CommandIntent | AppError =>
  parsedIntent.globals.outputMode === "json" ||
  parsedIntent.globals.profile ||
  parsedIntent.globals.config ||
  parsedIntent.globals.provider ||
  parsedIntent.globals.deployment ||
  hasProviderFieldInput(parsedIntent.globals)
    ? configuredIntent
    : activeProfileIntent(configuredIntent, runtime);

const hasProviderFieldArg = (argv: readonly string[]): boolean =>
  argv.some((token) => token.startsWith("--") && isProviderField(token.slice(2)));

const activeProfileDefaultBlocked = (argv: readonly string[]): boolean =>
  outputModeFromArgv(argv) === "json" ||
  argv.includes("--profile") ||
  argv.includes("--config") ||
  argv.includes("--provider") ||
  argv.includes("--deployment") ||
  hasProviderFieldArg(argv);

export const runCli = async (
  provider?: ProviderKind,
  argv = process.argv.slice(2),
): Promise<void> => {
  const runtimeInfo = currentRuntimeInfo();
  const runtime = makeCommandRuntime(runtimeInfo);
  const scopedArgv: ProviderScopedArgv = provider
    ? providerScopedArgv(provider, argv)
    : { ok: true, argv };
  if (!scopedArgv.ok) {
    process.stdout.write(renderResult(scopedArgv.result, outputModeFromArgv(argv)));
    process.exitCode = 1;
    return;
  }
  if (helpRequested(scopedArgv.argv)) {
    process.stdout.write(
      renderUsage(helpProvider(provider, scopedArgv.argv), provider),
    );
    process.exitCode = 0;
    return;
  }
  const resolvedArgv = activeProfileArgv(
    scopedArgv.argv,
    runtime,
    activeProfileDefaultBlocked(argv),
    provider,
  );
  if (!resolvedArgv.ok) {
    process.stdout.write(renderResult(resolvedArgv.result, outputModeFromArgv(argv)));
    process.exitCode = 1;
    return;
  }

  const parsed = parseArgs(resolvedArgv.argv);
  const configured = parsed.ok ? configuredIntent(parsed.intent) : undefined;
  const active =
    parsed.ok && configured && !("code" in configured)
      ? applyActiveProfileDefault(parsed.intent, configured, runtime)
      : undefined;
  const intent = active && !("code" in active) ? active : undefined;
  let result: CommandResult;
  if (!parsed.ok) {
    result = parsed.result;
  } else if (configured && "code" in configured) {
    result = runtimeErrorResult(parsed.intent.command, configured);
  } else if (active && "code" in active) {
    result = runtimeErrorResult(parsed.intent.command, active);
  } else if (intent) {
    const inputError = validateResolvedCommandInput(intent);
    const runtimeError = inputError ?? validateRuntime(intent, runtimeInfo);
    if (runtimeError) {
      result = runtimeErrorResult(intent.command, runtimeError);
    } else if (intent.command === "status" && intent.watch) {
      await runStatusWatch(intent, runtime);
      return;
    } else if (intent.command === "tui") {
      await runTuiIntent(intent, runtime);
      process.exitCode = 0;
      return;
    } else {
      result = await runIntent(intent, runtime);
    }
  } else {
    result = runtimeErrorResult(parsed.intent.command, {
      code: "args.invalid",
      message: "Command input did not produce an executable intent.",
    });
  }
  const outputMode = parsed.ok
    ? intent?.globals.outputMode ?? parsed.intent.globals.outputMode
    : parsed.outputMode;

  process.stdout.write(renderResult(result, outputMode));
  process.exitCode = result.ok ? 0 : 1;
};
