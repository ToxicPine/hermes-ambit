import type { CloudEvent, Remediation } from "@cardelli/shared";

export type ProviderKind = "gcp" | "azure";
export type OutputMode = "tui" | "cli" | "json";
export type InputMode = "interactive" | "nonInteractive";
export type AuthMode = "auto" | "browser" | "device";
export type ColorMode = "auto" | "always" | "never";

export type AppErrorCode =
  | "args.invalid"
  | "args.missing"
  | "auth.unavailable"
  | "command.confirmationRequired"
  | "config.unavailable"
  | "config.invalid"
  | "config.readFailed"
  | "profile.invalid"
  | "profile.notFound"
  | "profile.readFailed"
  | "profile.storeUnavailable"
  | "profile.deleteFailed"
  | "profile.writeFailed"
  | "provider.invalid"
  | "provider.failed"
  | "runtime.stdinUnavailable"
  | "runtime.ttyRequired"
  | "state.unavailable";

export type AppError = {
  readonly code: AppErrorCode;
  readonly message: string;
};

export type ResultContext = {
  readonly profile?: string;
  readonly provider?: ProviderKind;
  readonly deployment?: string;
};

export type GlobalOptions = {
  readonly profile?: string;
  readonly deployment?: string;
  readonly provider?: ProviderKind;
  readonly config?: string;
  readonly outputMode: OutputMode;
  readonly inputMode: InputMode;
  readonly noBrowser: boolean;
  readonly auth?: AuthMode;
  readonly debug: boolean;
  readonly color: ColorMode;
  readonly colorExplicit?: boolean;
  readonly providerFields: Readonly<Record<string, string>>;
};

export type CommandIntent =
  | {
      readonly command: "tui";
      readonly globals: GlobalOptions;
      readonly explicit: boolean;
    }
  | {
      readonly command: "setup";
      readonly globals: GlobalOptions;
      readonly quick: boolean;
      readonly reset: boolean;
      readonly reconfigure: boolean;
    }
  | { readonly command: "auth.check"; readonly globals: GlobalOptions }
  | { readonly command: "discover"; readonly globals: GlobalOptions }
  | { readonly command: "models.list"; readonly globals: GlobalOptions }
  | {
      readonly command: "deploy";
      readonly globals: GlobalOptions;
      readonly yes: boolean;
    }
  | {
      readonly command: "status";
      readonly globals: GlobalOptions;
      readonly watch: boolean;
    }
  | { readonly command: "config.show"; readonly globals: GlobalOptions }
  | {
      readonly command: "config.set";
      readonly globals: GlobalOptions;
      readonly key: string;
      readonly value: string;
    }
  | { readonly command: "secrets.list"; readonly globals: GlobalOptions }
  | {
      readonly command: "secrets.set";
      readonly globals: GlobalOptions;
      readonly name: string;
      readonly source: SecretInputSource;
    }
  | {
      readonly command: "secrets.delete";
      readonly globals: GlobalOptions;
      readonly name: string;
    }
  | {
      readonly command: "restart";
      readonly globals: GlobalOptions;
      readonly yes: boolean;
    }
  | {
      readonly command: "destroy";
      readonly globals: GlobalOptions;
      readonly yes: boolean;
      readonly state?: DestroyState;
    }
  | { readonly command: "doctor"; readonly globals: GlobalOptions };

export type CommandName = CommandIntent["command"];

export const commandMustNotPrompt = (intent: CommandIntent): boolean =>
  intent.command === "status" ||
  intent.command === "doctor" ||
  intent.command === "config.show" ||
  intent.command === "secrets.list";

export type CommandResult =
  | ({
      readonly ok: true;
      readonly command: CommandName;
      readonly summary: string;
      readonly data?: unknown;
      readonly debug?: unknown;
      readonly diagnostics?: readonly CloudEvent[];
    } & ResultContext)
  | ({
      readonly ok: false;
      readonly command: CommandName;
      readonly error: AppError;
      readonly diagnostics?: readonly CloudEvent[];
      readonly remediations?: readonly Remediation[];
    } & ResultContext);

export type ExecutableCommandIntent = Exclude<
  CommandIntent,
  { readonly command: "tui" }
>;

export type DestroyState = "retain" | "purge";

export type SecretInputSource =
  | { readonly type: "prompt" }
  | { readonly type: "stdin" }
  | { readonly type: "env"; readonly name: string };

export type ParsedCommand =
  | { readonly ok: true; readonly intent: CommandIntent }
  | {
      readonly ok: false;
      readonly result: CommandResult;
      readonly outputMode: OutputMode;
    };
