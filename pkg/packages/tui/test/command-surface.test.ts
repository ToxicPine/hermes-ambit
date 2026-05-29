import { describe, expect, test } from "bun:test";

import {
  RemediationRequired,
  emitCloudEvent,
  type HomeManagerPatch,
} from "@cardelli/shared";
import { Effect } from "effect";

import type { AppProfile } from "../src/app-profile.js";
import { parseArgs } from "../src/args.js";
import { applyActiveProfileDefault, helpRequested } from "../src/cli-runtime.js";
import { runIntent, validateRuntime, type CommandRuntime } from "../src/command.js";
import { mergeConfigIntoIntent } from "../src/config-file.js";
import type {
  ProviderAuthSummary,
  ProviderDeployPreviewSummary,
  ProviderStatusSummary,
  SupportedModelSummary,
} from "../src/provider-summary.js";
import type { ProfileStore } from "../src/profile-store.js";
import type {
  LocalCredentialRequest,
  ProviderAuthTarget,
  ProviderDiscoveryTarget,
  ProviderModelTarget,
  ProviderOperationResult,
  ProviderRunner,
} from "../src/profile-runner.js";
import { renderHuman, renderJson } from "../src/render.js";
import type { CommandIntent, InputMode, OutputMode } from "../src/types.js";

const expectInvalid = (argv: readonly string[], message: string) => {
  const parsed = parseArgs(argv);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.result.error.message).toContain(message);
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordFrom = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  isRecord(value) ? value : undefined;

const authSummaryFor = (target: ProviderAuthTarget): ProviderAuthSummary =>
  target.provider === "gcp"
    ? {
        ...(target.quotaProjectId
          ? { quotaProjectId: target.quotaProjectId }
          : {}),
      }
    : {
        tenantId: target.tenantId,
        subscriptionId: target.subscriptionId,
        expiresAtEpochSeconds: 1_800_000_000,
      };

const operationResult = <T>(
  summary: T,
  raw: unknown = {},
): ProviderOperationResult<T> => ({
  summary,
  raw,
});

const emptyDiscoveryResult = (
  boundary: ProviderDiscoveryTarget["boundary"],
) => operationResult({ boundary, deployments: [] }, []);

const emptyModelsResult = () => operationResult([], []);

const successfulSetupValidationRunners: Pick<
  CommandRuntime,
  "authRunners" | "discoveryRunners"
> = {
  authRunners: (target) => ({
    authCheck: () => Effect.succeed(authSummaryFor(target)),
  }),
  discoveryRunners: (target) => ({
    discover: () => Effect.succeed(emptyDiscoveryResult(target.boundary)),
  }),
};

const profileStoreFor = (profile: AppProfile): ProfileStore => ({
  readActiveProfileName: () => profile.name,
  writeActiveProfileName: () => undefined,
  readProfile: (name) =>
    name === profile.name
      ? profile
      : {
          code: "profile.notFound",
          message: `Profile ${name} is not configured. Run setup first.`,
        },
  writeProfile: () => undefined,
  deleteProfile: () => ({ deleted: false }),
});

const gcpRunnerCapturingPatch = (
  capture: (patch: HomeManagerPatch) => void,
): ProviderRunner => {
  const status: ProviderOperationResult<ProviderStatusSummary> = {
    summary: {
      deployed: true,
    },
    raw: {},
  };
  const preview: ProviderOperationResult<ProviderDeployPreviewSummary> = {
    summary: {
      boundary: {
        projectId: "project",
        region: "us-central1",
      },
      state: {
        kind: "nfs",
        server: "10.0.0.8",
        dataPath: "/exports/data",
        nixPath: "/exports/nix",
      },
      resources: [
        {
          action: "create",
          resourceKind: "cloud-run-service",
          resourceName: "demo",
        },
      ],
    },
    raw: {},
  };

  return {
    authCheck: () => Effect.succeed({}),
    discover: () =>
      Effect.succeed(
        emptyDiscoveryResult({
          projectId: "project",
          region: "us-central1",
        }),
      ),
    previewDeploy: () => Effect.succeed(preview),
    status: () => Effect.succeed(status),
    listSecrets: () => Effect.succeed([]),
    putSecret: () => Effect.succeed(status),
    deleteSecret: () => Effect.succeed(status),
    restart: () => Effect.succeed(status),
    destroy: () => Effect.succeed(status),
    applyHomeManagerPatch: (patch) => {
      capture(patch);
      return Effect.succeed(status);
    },
  };
};

const azureRunnerCapturingPatch = (
  capture: (patch: HomeManagerPatch) => void,
): ProviderRunner => {
  const status: ProviderOperationResult<ProviderStatusSummary> = {
    summary: {
      deployed: true,
    },
    raw: {},
  };

  return {
    authCheck: () =>
      Effect.succeed({
        tenantId: "tenant",
        subscriptionId: "subscription",
        expiresAtEpochSeconds: 1_800_000_000,
      }),
    discover: () =>
      Effect.succeed(
        emptyDiscoveryResult({
          subscriptionId: "subscription",
          resourceGroupName: "hermes",
        }),
      ),
    status: () => Effect.succeed(status),
    listSecrets: () => Effect.succeed([]),
    putSecret: () => Effect.succeed(status),
    deleteSecret: () => Effect.succeed(status),
    restart: () => Effect.succeed(status),
    destroy: () => Effect.succeed(status),
    applyHomeManagerPatch: (patch) => {
      capture(patch);
      return Effect.succeed(status);
    },
  };
};

const azureRunnerWithStatePurge = (onPurge: () => void): ProviderRunner => {
  const runner = azureRunnerCapturingPatch(() => undefined);
  return {
    ...runner,
    destroyWithStatePurge: () => {
      onPurge();
      return runner.destroy();
    },
  };
};

const azureDestroyPurgeIntent = (
  outputMode: OutputMode,
  inputMode: InputMode,
): Extract<CommandIntent, { readonly command: "destroy" }> => ({
  command: "destroy",
  globals: {
    outputMode,
    inputMode,
    noBrowser: inputMode === "nonInteractive",
    debug: false,
    color: outputMode === "json" ? "never" : "auto",
    provider: "azure",
    deployment: "demo",
    providerFields: {
      tenant: "tenant",
      subscription: "subscription",
      "resource-group": "hermes",
      location: "eastus",
      "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
      "storage-name": "hermes",
    },
  },
  yes: outputMode !== "json",
  state: "purge",
});

describe("command surface validation", () => {
  test("does not expose a public plan command", () => {
    expectInvalid(["plan", "--json"], "Unknown command: plan");
  });

  test("recognizes help after provider-scoped globals", () => {
    expect(helpRequested(["--provider", "gcp", "help"])).toBe(true);
    expect(helpRequested(["--provider", "gcp", "--help"])).toBe(true);
    expect(helpRequested(["--deployment", "help", "status"])).toBe(false);
  });

  test("rejects bare and explicit TUI launch without a TTY", () => {
    const bare = parseArgs([]);
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      const error = validateRuntime(bare.intent, {
        stdinIsTty: false,
        stdoutIsTty: false,
        stderrIsTty: false,
      });
      expect(error?.message).toContain("No command was provided");
    }

    const explicit = parseArgs(["tui"]);
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      const error = validateRuntime(explicit.intent, {
        stdinIsTty: false,
        stdoutIsTty: false,
        stderrIsTty: false,
      });
      expect(error?.message).toContain("TUI mode requires stdin, stdout, and stderr");
    }
  });

  test("renders the stable JSON envelope with context and remediations", () => {
    const remediation = {
      type: "auth",
      label: "Set up provider credentials",
      url: "https://example.com/auth",
    };
    const envelope: unknown = JSON.parse(
      renderJson({
        ok: false,
        command: "deploy",
        profile: "default",
        provider: "gcp",
        deployment: "demo",
        error: {
          code: "auth.unavailable",
          message: "Provider credentials are not available.",
        },
        remediations: [remediation],
      }),
    );
    const record = recordFrom(envelope);

    expect(record?.["ok"]).toBe(false);
    expect(record?.["command"]).toBe("deploy");
    expect(record?.["profile"]).toBe("default");
    expect(record?.["provider"]).toBe("gcp");
    expect(record?.["deployment"]).toBe("demo");
    expect(recordFrom(record?.["error"])?.["code"]).toBe("auth.unavailable");
    expect(record?.["diagnostics"]).toEqual([]);
    expect(record?.["remediations"]).toEqual([remediation]);
  });

  test("does not expose a restart-only config sync command", () => {
    expectInvalid(["config", "sync"], "Unexpected argument for config");
  });

  test("does not expose provider-derived base URL as a direct config key", async () => {
    const result = await runIntent({
      command: "config.set",
      globals: {
        outputMode: "cli",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "auto",
        provider: "gcp",
        deployment: "demo",
        providerFields: {
          project: "project",
          region: "us-central1",
          "state-server": "10.0.0.8",
          "state-path": "/exports/hermes",
        },
      },
      key: "model.base_url",
      value: "https://example.invalid",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not in the supported v1 set");
    }
  });

  test("does not expose provider as a direct model config key", async () => {
    const result = await runIntent({
      command: "config.set",
      globals: {
        outputMode: "cli",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "auto",
        provider: "azure",
        deployment: "demo",
        providerFields: {
          tenant: "tenant",
          subscription: "subscription",
          "resource-group": "hermes",
          location: "eastus",
          "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
          "storage-name": "hermes",
        },
      },
      key: "model.provider",
      value: "azure-foundry",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not in the supported v1 set");
    }
  });

  test("keeps setup out of JSON mode", () => {
    expectInvalid(["setup", "--json"], "setup does not support --json");
  });

  test("requires complete direct input for non-interactive setup", () => {
    expectInvalid(["setup", "--no-input"], "Missing required provider");
    expectInvalid(
      [
        "setup",
        "--no-input",
        "--provider",
        "gcp",
        "--deployment",
        "demo",
        "--project",
        "project",
        "--region",
        "us-central1",
      ],
      "Missing required GCP field",
    );
  });

  test("rejects deployment identities that would be lossy cloud resource names", () => {
    expectInvalid(
      ["status", "--provider", "gcp", "--deployment", "Demo_Agent"],
      "Deployment names must start with a lowercase letter or number",
    );
  });

  test("allows setup to carry the selected cloud auth strategy", () => {
    const parsed = parseArgs([
      "setup",
      "--provider",
      "azure",
      "--deployment",
      "demo",
      "--auth",
      "device",
    ]);

    expect(parsed.ok).toBe(true);
  });

  test("routes device-code auth prompts through the runtime", async () => {
    let promptMessage = "";
    const result = await runIntent(
      {
        command: "auth.check",
        globals: {
          outputMode: "cli",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          auth: "device",
          provider: "azure",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
          },
        },
      },
      {
        deviceCodePrompt: (message) => {
          promptMessage = message;
        },
        authRunners: (target, request) => ({
          authCheck: () => {
            request.deviceCodePrompt?.("Enter code ABCD.");
            return Effect.succeed(authSummaryFor(target));
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(promptMessage).toBe("Enter code ABCD.");
  });

  test("passes runtime env through credential requests", async () => {
    let capturedEnv: Readonly<Record<string, string | undefined>> | undefined;
    const result = await runIntent(
      {
        command: "auth.check",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "azure",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
          },
        },
      },
      {
        env: { AZURE_CLIENT_ID: "client-id" },
        authRunners: (target, request) => {
          capturedEnv = request.env;
          return {
            authCheck: () => Effect.succeed(authSummaryFor(target)),
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedEnv?.AZURE_CLIENT_ID).toBe("client-id");
  });

  test("auth check probes the provider boundary when enough input is supplied", async () => {
    let authChecked = false;
    let discoveryProject = "";

    const result = await runIntent(
      {
        command: "auth.check",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          providerFields: {
            project: "project",
            region: "us-central1",
          },
        },
      },
      {
        authRunners: (target) => ({
          authCheck: () => {
            authChecked = true;
            return Effect.succeed(authSummaryFor(target));
          },
        }),
        discoveryRunners: (target) => ({
          discover: () => {
            if (target.provider === "gcp") {
              discoveryProject = target.boundary.projectId;
              return Effect.succeed(emptyDiscoveryResult(target.boundary));
            }

            return Effect.succeed(emptyDiscoveryResult(target.boundary));
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(authChecked).toBe(true);
    expect(discoveryProject).toBe("project");
    if (result.ok) {
      expect(result.summary).toContain("reach the selected cloud boundary");
      expect(recordFrom(result.data)?.["boundaryChecked"]).toBe(true);
    }
  });

  test("auth check uses the saved profile boundary with same-provider globals", async () => {
    let discoveryProject = "";
    const profile: AppProfile = {
      provider: "gcp",
      name: "default",
      deployment: "demo",
      user: "user",
      gcp: {
        projectId: "profile-project",
        region: "us-central1",
        state: {
          server: "10.0.0.8",
          dataPath: "/exports/data",
          nixPath: "/exports/nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "auth.check",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          providerFields: {},
        },
      },
      {
        profiles: profileStoreFor(profile),
        authRunners: (target) => ({
          authCheck: () => Effect.succeed(authSummaryFor(target)),
        }),
        discoveryRunners: (target) => ({
          discover: () => {
            if (target.provider === "gcp") {
              discoveryProject = target.boundary.projectId;
              return Effect.succeed(emptyDiscoveryResult(target.boundary));
            }

            return Effect.succeed(emptyDiscoveryResult(target.boundary));
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(discoveryProject).toBe("profile-project");
    if (result.ok) {
      expect(recordFrom(result.data)?.["boundaryChecked"]).toBe(true);
    }
  });

  test("auth check reports Azure account and expiry without token material", async () => {
    const result = await runIntent(
      {
        command: "auth.check",
        globals: {
          outputMode: "json",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "never",
          provider: "azure",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
          },
        },
      },
      {
        authRunners: (target) => ({
          authCheck: () => Effect.succeed(authSummaryFor(target)),
        }),
      },
    );

    expect(result.ok).toBe(true);
    const envelope = recordFrom(JSON.parse(renderJson(result)));
    const data = recordFrom(envelope?.["data"]);
    expect(data?.["tenantId"]).toBe("tenant");
    expect(data?.["subscriptionId"]).toBe("subscription");
    expect(data?.["tokenType"]).toBeUndefined();
    expect(data?.["expiresAtEpochSeconds"]).toBe(1_800_000_000);
    expect(JSON.stringify(envelope)).not.toContain("accessToken");
  });

  test("rejects confirmation and watch flags on unrelated commands", () => {
    expectInvalid(["status", "--yes"], "Unexpected argument for status");
    expectInvalid(["deploy", "--watch"], "Unexpected argument for deploy");
  });

  test("rejects the documented invalid argument combinations", () => {
    const cases: readonly {
      readonly argv: readonly string[];
      readonly message: string;
    }[] = [
      {
        argv: ["tui", "--json"],
        message: "TUI mode cannot be combined with --json",
      },
      {
        argv: ["tui", "--yes"],
        message: "Unexpected argument for tui",
      },
      {
        argv: ["tui", "--watch"],
        message: "Unexpected argument for tui",
      },
      {
        argv: ["setup", "model"],
        message: "Unexpected argument for setup",
      },
      {
        argv: ["status", "--watch", "--json"],
        message: "status --watch does not support --json",
      },
      {
        argv: ["deploy", "--json", "--yes"],
        message: "--yes is only valid for human CLI confirmation",
      },
      {
        argv: ["auth", "check", "--auth", "browser", "--no-input"],
        message: "--auth browser requires interactive input",
      },
      {
        argv: [
          "auth",
          "check",
          "--provider",
          "azure",
          "--tenant",
          "tenant",
          "--subscription",
          "subscription",
          "--auth",
          "device",
          "--json",
        ],
        message: "--auth device requires interactive input",
      },
      {
        argv: ["status", "--provider", "gcp", "--subscription", "subscription"],
        message: "--subscription is only valid with --provider azure",
      },
      {
        argv: ["status", "--provider", "gcp", "--tenant", "tenant"],
        message: "--tenant is only valid with --provider azure",
      },
      {
        argv: [
          "status",
          "--provider",
          "gcp",
          "--resource-group",
          "hermes",
        ],
        message: "--resource-group is only valid with --provider azure",
      },
      {
        argv: [
          "status",
          "--provider",
          "gcp",
          "--environment-id",
          "environment",
        ],
        message: "--environment-id is only valid with --provider azure",
      },
    ];

    for (const entry of cases) {
      expectInvalid(entry.argv, entry.message);
    }
  });

  test("requires an explicit destroy state when automation confirms destroy", () => {
    expectInvalid(["destroy", "--yes"], "destroy --yes requires");
    expectInvalid(
      ["destroy", "--retain-state", "--purge-state"],
      "accepts only one of",
    );
  });

  test("rejects non-interactive TUI and provider-mismatched fields", () => {
    expectInvalid(["tui", "--no-input"], "TUI mode requires interactive input");
    expectInvalid(
      ["status", "--provider", "azure", "--project", "project"],
      "--project is only valid with --provider gcp",
    );
  });

  test("keeps non-prompting read commands off interactive auth paths", async () => {
    let capturedRequest: LocalCredentialRequest | undefined;
    const result = await runIntent(
      {
        command: "status",
        globals: {
          outputMode: "cli",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          provider: "azure",
          deployment: "demo",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
            "resource-group": "hermes",
          },
        },
        watch: false,
      },
      {
        deviceCodePrompt: () => undefined,
        runners: (_target, request) => {
          capturedRequest = request;
          return azureRunnerCapturingPatch(() => undefined);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedRequest?.inputMode).toBe("nonInteractive");
    expect(capturedRequest?.noBrowser).toBe(true);
    expect(capturedRequest?.deviceCodePrompt).toBeUndefined();
    expectInvalid(
      [
        "status",
        "--provider",
        "azure",
        "--deployment",
        "demo",
        "--tenant",
        "tenant",
        "--subscription",
        "subscription",
        "--resource-group",
        "hermes",
        "--auth",
        "browser",
      ],
      "status does not support interactive auth",
    );
  });

  test("requires non-prompt secret sources in JSON and no-input modes", () => {
    expectInvalid(
      ["secrets", "set", "GOOGLE_API_KEY", "--json"],
      "requires --value-stdin or --from-env",
    );
    expectInvalid(
      ["secrets", "set", "GOOGLE_API_KEY", "--no-input"],
      "requires --value-stdin or --from-env",
    );
  });

  test("keeps non-interactive human secret updates scriptable", () => {
    const parsed = parseArgs([
      "secrets",
      "set",
      "GOOGLE_API_KEY",
      "--no-input",
      "--from-env",
      "GOOGLE_API_KEY",
      "--provider",
      "gcp",
      "--deployment",
      "demo",
      "--project",
      "project",
      "--region",
      "us-central1",
    ]);

    expect(parsed.ok).toBe(true);
  });

  test("returns remediation carried by provider errors", async () => {
    const remediation = {
      type: "auth",
      label: "Set up provider credentials",
      url: "https://example.com/auth",
    };

    const result = await runIntent(
      {
        command: "auth.check",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          providerFields: {},
        },
      },
      {
        authRunners: () => ({
          authCheck: () =>
            Effect.fail(
              new RemediationRequired({
                scope: "auth",
                message: "Provider credentials are not available.",
                remediation,
              }),
            ),
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth.unavailable");
      expect(result.remediations).toEqual([remediation]);
    }
  });

  test("accepts a GCP runtime service account without exposing it to Azure", () => {
    const parsed = parseArgs([
      "setup",
      "--provider",
      "gcp",
      "--deployment",
      "demo",
      "--project",
      "project",
      "--region",
      "us-central1",
      "--service-account",
      "hermes-runtime@project.iam.gserviceaccount.com",
      "--state-server",
      "10.0.0.8",
      "--state-path",
      "/exports/hermes",
      "--no-input",
    ]);

    expect(parsed.ok).toBe(true);
    expectInvalid(
      ["setup", "--provider", "azure", "--service-account", "sa@example.com"],
      "--service-account is only valid with --provider gcp",
    );
  });

  test("allows JSON secret updates only with indirect values", () => {
    const parsed = parseArgs([
      "secrets",
      "set",
      "GOOGLE_API_KEY",
      "--json",
      "--from-env",
      "GOOGLE_API_KEY",
      "--provider",
      "gcp",
      "--deployment",
      "demo",
      "--project",
      "project",
      "--region",
      "us-central1",
    ]);

    expect(parsed.ok).toBe(true);
  });

  test("accepts a complete JSON model-list command", () => {
    const parsed = parseArgs([
      "models",
      "list",
      "--json",
      "--provider",
      "gcp",
      "--region",
      "us-central1",
    ]);
    expect(parsed.ok).toBe(true);
  });

  test("keeps raw discovery and model payloads behind debug output", async () => {
    const discoveryResult = await runIntent(
      {
        command: "discover",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: true,
          color: "auto",
          provider: "gcp",
          providerFields: {
            project: "project",
            region: "us-central1",
          },
        },
      },
      {
        discoveryRunners: (target) => ({
          discover: () =>
            Effect.succeed(
              operationResult(
                {
                  boundary: target.boundary,
                  deployments: [],
                },
                [{ providerName: "raw-service" }],
              ),
            ),
        }),
      },
    );
    expect(discoveryResult.ok).toBe(true);
    if (discoveryResult.ok) {
      expect(discoveryResult.data).toEqual({
        boundary: {
          projectId: "project",
          region: "us-central1",
        },
        deployments: [],
      });
      expect(discoveryResult.debug).toEqual([{ providerName: "raw-service" }]);
    }

    const supportedModels = [
      {
        id: "gemini-3-flash-preview",
        route: "gemini/developer-api",
        runtimeTarget: "model-id",
      },
    ] satisfies readonly SupportedModelSummary[];
    const modelResult = await runIntent(
      {
        command: "models.list",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: true,
          color: "auto",
          provider: "gcp",
          providerFields: {
            region: "us-central1",
          },
        },
      },
      {
        modelRunners: () => ({
          listModels: () =>
            Effect.succeed(
              operationResult(
                supportedModels,
                [{ providerName: "raw-model" }],
              ),
            ),
        }),
      },
    );
    expect(modelResult.ok).toBe(true);
    if (modelResult.ok) {
      expect(modelResult.data).toEqual(supportedModels);
      expect(modelResult.debug).toEqual([{ providerName: "raw-model" }]);
    }
  });

  test("runs doctor from explicit provider inputs without a profile", async () => {
    let authChecked = false;
    let discoveryProject = "";
    let modelRegion = "";

    const result = await runIntent(
      {
        command: "doctor",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          providerFields: {
            project: "project",
            region: "us-central1",
          },
        },
      },
      {
        authRunners: (target) => ({
          authCheck: () => {
            authChecked = true;
            return Effect.succeed(authSummaryFor(target));
          },
        }),
        discoveryRunners: (target) => {
          if (target.provider === "gcp") {
            discoveryProject = target.boundary.projectId;
            return {
              discover: () =>
                Effect.succeed(emptyDiscoveryResult(target.boundary)),
            };
          }

          return {
            discover: () =>
              Effect.succeed(emptyDiscoveryResult(target.boundary)),
          };
        },
        modelRunners: (target) => {
          if (target.provider === "gcp") {
            modelRegion = target.region;
          }
          return {
            listModels: () => Effect.succeed(emptyModelsResult()),
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "Doctor checked gcp profile default: 5 passed, 1 failed, 1 skipped.",
    );
    if (result.ok) {
      expect(result.data).toMatchObject({
        checks: [
          { name: "profile", status: "skipped" },
          { name: "runtime", status: "passed" },
          { name: "config", status: "passed" },
          { name: "image", status: "failed" },
          { name: "auth", status: "passed" },
          { name: "discovery", status: "passed" },
          { name: "models", status: "passed" },
        ],
      });
    }
    expect(authChecked).toBe(true);
    expect(discoveryProject).toBe("project");
    expect(modelRegion).toBe("us-central1");
  });

  test("runs provider setup validation when doctor has a complete deployment spec", async () => {
    let setupValidated = false;

    const result = await runIntent(
      {
        command: "doctor",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
      },
      {
        authRunners: (target) => ({
          authCheck: () => Effect.succeed(authSummaryFor(target)),
        }),
        discoveryRunners: (target) => ({
          discover: () => Effect.succeed(emptyDiscoveryResult(target.boundary)),
        }),
        modelRunners: () => ({
          listModels: () => Effect.succeed(emptyModelsResult()),
        }),
        runners: () => ({
          ...gcpRunnerCapturingPatch(() => undefined),
          validateSetup: () => {
            setupValidated = true;
            return Effect.void;
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "Doctor checked gcp profile default: 6 passed, 1 failed, 1 skipped.",
    );
    if (result.ok) {
      expect(result.data).toMatchObject({
        checks: [
          { name: "profile", status: "skipped" },
          { name: "runtime", status: "passed" },
          { name: "config", status: "passed" },
          { name: "image", status: "failed" },
          { name: "auth", status: "passed" },
          { name: "state", status: "passed" },
          { name: "discovery", status: "passed" },
          { name: "models", status: "passed" },
        ],
      });
    }
    expect(setupValidated).toBe(true);
  });

  test("reports global image readiness even when the profile is missing", async () => {
    const result = await runIntent(
      {
        command: "doctor",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {},
        },
      },
      {
        profiles: {
          readActiveProfileName: () => undefined,
          writeActiveProfileName: () => undefined,
          readProfile: (name) => ({
            code: "profile.notFound",
            message: `Profile ${name} is not configured. Run setup first.`,
          }),
          writeProfile: () => undefined,
          deleteProfile: () => ({ deleted: false }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "Doctor checked profile default: 1 passed, 2 failed, 0 skipped.",
    );
    if (result.ok) {
      expect(result.data).toMatchObject({
        checks: [
          { name: "profile", status: "failed" },
          { name: "runtime", status: "passed" },
          { name: "image", status: "failed" },
        ],
      });
    }
  });

  test("keeps TUI setup on the editable draft path instead of CLI prompts", async () => {
    let prompted = false;
    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "tui",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          provider: "gcp",
          deployment: "demo",
          providerFields: {},
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        promptText: async () => {
          prompted = true;
          return "should-not-run";
        },
      },
    );

    expect(prompted).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing required GCP field");
    }
  });

  test("marks a saved setup profile as active", async () => {
    let wroteProfile: AppProfile | undefined;
    let activeProfileName: string | undefined;
    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "cli",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          profile: "work",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        ...successfulSetupValidationRunners,
        profiles: {
          readActiveProfileName: () => undefined,
          writeActiveProfileName: (name) => {
            activeProfileName = name;
            return undefined;
          },
          readProfile: () => ({
            code: "profile.notFound",
            message: "Profile work is not configured. Run setup first.",
          }),
          writeProfile: (profile) => {
            wroteProfile = profile;
            return undefined;
          },
          deleteProfile: () => ({ deleted: false }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(wroteProfile?.name).toBe("work");
    expect(activeProfileName).toBe("work");
  });

  test("validates interactive setup before saving the profile", async () => {
    let wroteProfile = false;
    const remediation = {
      type: "auth",
      label: "Set up provider credentials",
      url: "https://example.com/auth",
    };

    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "cli",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          profile: "work",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        profiles: {
          readActiveProfileName: () => undefined,
          writeActiveProfileName: () => undefined,
          readProfile: () => ({
            code: "profile.notFound",
            message: "Profile work is not configured. Run setup first.",
          }),
          writeProfile: () => {
            wroteProfile = true;
            return undefined;
          },
          deleteProfile: () => ({ deleted: false }),
        },
        authRunners: () => ({
          authCheck: () =>
            Effect.fail(
              new RemediationRequired({
                scope: "auth",
                message: "Provider credentials are not available.",
                remediation,
              }),
            ),
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth.unavailable");
      expect(result.remediations).toEqual([remediation]);
    }
    expect(wroteProfile).toBe(false);
  });

  test("prompts for the optional GCP runtime service account in full setup", async () => {
    let wroteProfile: AppProfile | undefined;
    const promptLabels: string[] = [];
    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "cli",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          profile: "work",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        ...successfulSetupValidationRunners,
        promptText: async (label) => {
          promptLabels.push(label);
          return "hermes-runtime@project.iam.gserviceaccount.com";
        },
        profiles: {
          readActiveProfileName: () => undefined,
          writeActiveProfileName: () => undefined,
          readProfile: () => ({
            code: "profile.notFound",
            message: "Profile work is not configured. Run setup first.",
          }),
          writeProfile: (profile) => {
            wroteProfile = profile;
            return undefined;
          },
          deleteProfile: () => ({ deleted: false }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(promptLabels).toEqual(["Cloud Run service account (optional)"]);
    expect(wroteProfile?.provider).toBe("gcp");
    if (wroteProfile?.provider === "gcp") {
      expect(wroteProfile.gcp.serviceAccount).toBe(
        "hermes-runtime@project.iam.gserviceaccount.com",
      );
    }
  });

  test("prompts for the optional Azure Foundry endpoint in full setup", async () => {
    let wroteProfile: AppProfile | undefined;
    const promptLabels: string[] = [];
    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "cli",
          inputMode: "interactive",
          noBrowser: false,
          debug: false,
          color: "auto",
          profile: "work",
          provider: "azure",
          deployment: "demo",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
            "resource-group": "hermes",
            location: "eastus",
            "environment-id":
              "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
            "storage-name": "hermes-state",
          },
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        ...successfulSetupValidationRunners,
        promptText: async (label) => {
          promptLabels.push(label);
          return "https://hermes.openai.azure.com";
        },
        profiles: {
          readActiveProfileName: () => undefined,
          writeActiveProfileName: () => undefined,
          readProfile: () => ({
            code: "profile.notFound",
            message: "Profile work is not configured. Run setup first.",
          }),
          writeProfile: (profile) => {
            wroteProfile = profile;
            return undefined;
          },
          deleteProfile: () => ({ deleted: false }),
        },
        runners: () => ({
          ...azureRunnerCapturingPatch(() => undefined),
          validateSetup: () => Effect.void,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(promptLabels).toEqual(["Foundry OpenAI-compatible endpoint"]);
    expect(wroteProfile?.provider).toBe("azure");
    if (wroteProfile?.provider === "azure") {
      expect(wroteProfile.azure.openaiCompatibleEndpoint).toBe(
        "https://hermes.openai.azure.com",
      );
    }
  });

  test("does not fill non-interactive setup from an existing profile", async () => {
    let wroteProfile = false;
    const profile: AppProfile = {
      provider: "gcp",
      name: "default",
      deployment: "demo",
      user: "user",
      gcp: {
        projectId: "project",
        region: "us-central1",
        state: {
          server: "10.0.0.8",
          dataPath: "/exports/data",
          nixPath: "/exports/nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          profile: "default",
          providerFields: {},
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        profiles: {
          ...profileStoreFor(profile),
          writeProfile: () => {
            wroteProfile = true;
            return undefined;
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing required provider");
    }
    expect(wroteProfile).toBe(false);
  });

  test("validates Azure environment storage before saving non-interactive setup", async () => {
    let wroteProfile = false;
    let checkedStorage = "";
    const remediation = {
      type: "url",
      label: "Create Container Apps environment storage",
      url: "https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts",
    };

    const result = await runIntent(
      {
        command: "setup",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          profile: "work",
          provider: "azure",
          deployment: "demo",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
            "resource-group": "hermes",
            location: "eastus",
            "environment-id":
              "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
            "storage-name": "hermes-state",
          },
        },
        quick: false,
        reset: false,
        reconfigure: false,
      },
      {
        profiles: {
          readActiveProfileName: () => undefined,
          writeActiveProfileName: () => undefined,
          readProfile: () => ({
            code: "profile.notFound",
            message: "Profile work is not configured. Run setup first.",
          }),
          writeProfile: () => {
            wroteProfile = true;
            return undefined;
          },
          deleteProfile: () => ({ deleted: false }),
        },
        authRunners: (target) => ({
          authCheck: () =>
            Effect.succeed(authSummaryFor(target)),
        }),
        discoveryRunners: (target) =>
          target.provider === "azure"
            ? {
                discover: () =>
                  Effect.succeed(emptyDiscoveryResult(target.boundary)),
              }
            : {
                discover: () =>
                  Effect.succeed(emptyDiscoveryResult(target.boundary)),
              },
        runners: (target) => {
          if (target.provider === "azure") {
            checkedStorage = target.deploymentSpec?.state.storageName ?? "";
          }
          return {
            ...azureRunnerCapturingPatch(() => undefined),
            validateSetup: () =>
              Effect.fail(
                new RemediationRequired({
                  scope: "azure.managedEnvironments.storages.require",
                  message:
                    "Azure Container Apps environment storage must exist before Hermes can mount durable state.",
                  remediation,
                }),
              ),
          };
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider.failed");
      expect(result.error.message).toContain("environment storage must exist");
      expect(result.remediations).toEqual([remediation]);
    }
    expect(checkedStorage).toBe("hermes-state");
    expect(wroteProfile).toBe(false);
  });

  test("lowers a GCP model default through the provider model selection shape", async () => {
    let capturedPatch: HomeManagerPatch | undefined;
    const result = await runIntent(
      {
        command: "config.set",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
        key: "model.default",
        value: "gemini-3-flash-preview",
      },
      {
        runners: () =>
          gcpRunnerCapturingPatch((patch) => {
            capturedPatch = patch;
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("runtime was rolled");
    expect(capturedPatch?.section).toBe("model");
    expect(capturedPatch?.block).toContain('provider = lib.mkForce "gemini";');
    expect(capturedPatch?.block).toContain(
      'default = lib.mkForce "gemini-3-flash-preview";',
    );
    expect(capturedPatch?.block).toContain(
      'base_url = lib.mkForce "https://generativelanguage.googleapis.com/v1beta";',
    );
  });

  test("shows deploy preview boundary before human confirmation", async () => {
    const result = await runIntent(
      {
        command: "deploy",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
        yes: false,
      },
      {
        runners: () => gcpRunnerCapturingPatch(() => undefined),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("command.confirmationRequired");
      expect(result.error.message).toContain(
        "project project, region us-central1",
      );
      expect(result.error.message).toContain(
        "Resources to create: Cloud Run service demo",
      );
      expect(result.error.message).toContain(
        "Config/secrets: unchanged by deploy",
      );
      expect(result.error.message).toContain(
        "State: NFS 10.0.0.8:/exports/data",
      );
      expect(result.error.message).toContain("leaves contents intact");
    }
  });

  test("shows destroy preview with runtime secrets and retained state", async () => {
    let listedSecrets = false;
    const result = await runIntent(
      {
        command: "destroy",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
          },
        },
        yes: false,
        state: "retain",
      },
      {
        runners: () => ({
          ...gcpRunnerCapturingPatch(() => undefined),
          listSecrets: () => {
            listedSecrets = true;
            return Effect.succeed(["GOOGLE_API_KEY"]);
          },
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("command.confirmationRequired");
      expect(result.error.message).toContain(
        "gcp Cloud Run service demo is deployed",
      );
      expect(result.error.message).toContain(
        "Runtime secrets to delete: GOOGLE_API_KEY.",
      );
      expect(result.error.message).toContain(
        "Persistent state will be retained.",
      );
    }
    expect(listedSecrets).toBe(true);
  });

  test("includes operation events in JSON mutation data", async () => {
    const status: ProviderOperationResult<ProviderStatusSummary> = {
      summary: {
        deployed: true,
      },
      raw: {},
    };
    const runner = gcpRunnerCapturingPatch(() => undefined);

    const result = await runIntent(
      {
        command: "deploy",
        globals: {
          outputMode: "json",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "never",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
            "state-server": "10.0.0.8",
            "state-path": "/exports/hermes",
          },
        },
        yes: false,
      },
      {
        runners: () => ({
          ...runner,
          deploy: () =>
            Effect.gen(function* () {
              yield* emitCloudEvent({
                level: "info",
                scope: "deployment",
                operation: "apply",
                resource: "demo",
                message: "Applying deployment preview",
              });
              return status;
            }),
        }),
      },
    );

    expect(result.ok).toBe(true);
    const data = result.ok ? recordFrom(result.data) : undefined;
    const operationEvents = data?.operationEvents;
    expect(Array.isArray(operationEvents)).toBe(true);
    const firstEvent = Array.isArray(operationEvents)
      ? recordFrom(operationEvents[0])
      : undefined;
    expect(firstEvent?.operation).toBe("apply");
  });

  test("includes operation events in JSON secret mutation data", async () => {
    const runner = gcpRunnerCapturingPatch(() => undefined);
    const result = await runIntent(
      {
        command: "secrets.set",
        globals: {
          outputMode: "json",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "never",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
          },
        },
        name: "GOOGLE_API_KEY",
        source: { type: "env", name: "TEST_GOOGLE_API_KEY" },
      },
      {
        env: {
          TEST_GOOGLE_API_KEY: "top-secret-value",
        },
        runners: () => ({
          ...runner,
          putSecret: (name) =>
            Effect.gen(function* () {
              yield* emitCloudEvent({
                level: "info",
                scope: "secrets",
                operation: "secret.update",
                resource: "demo",
                message: `Updating runtime secret ${name}`,
              });
              return yield* runner.putSecret(name, "redacted");
            }),
        }),
      },
    );

    expect(result.ok).toBe(true);
    const data = result.ok ? recordFrom(result.data) : undefined;
    const operationEvents = data?.operationEvents;
    expect(Array.isArray(operationEvents)).toBe(true);
    const firstEvent = Array.isArray(operationEvents)
      ? recordFrom(operationEvents[0])
      : undefined;
    expect(firstEvent?.operation).toBe("secret.update");
    expect(firstEvent?.message).toBe("Updating runtime secret GOOGLE_API_KEY");
    expect(firstEvent?.message).not.toContain("top-secret-value");
  });

  test("redacts secret-bearing fields from debug raw provider data", async () => {
    const runner = gcpRunnerCapturingPatch(() => undefined);
    const raw = {
      accessToken: "raw-access-token",
      properties: {
        configuration: {
          secrets: [{ name: "api-key", value: "raw-secret-value" }],
        },
        azureFile: {
          accountName: "storage-account",
          accountKey: "raw-storage-account-key",
          shareName: "state",
        },
      },
      payload: {
        data: "base64-secret-payload",
      },
      nextPageToken: "page-token-is-not-a-credential",
    };

    const result = await runIntent(
      {
        command: "status",
        globals: {
          outputMode: "json",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: true,
          color: "never",
          provider: "gcp",
          deployment: "demo",
          providerFields: {
            project: "project",
            region: "us-central1",
          },
        },
        watch: false,
      },
      {
        runners: () => ({
          ...runner,
          status: () =>
            Effect.succeed({
              summary: {
                deployed: true,
              },
              raw,
            }),
        }),
      },
    );

    expect(result.ok).toBe(true);
    const debug = result.ok ? recordFrom(result.debug) : undefined;
    const runtime = recordFrom(debug?.runtime);
    const properties = recordFrom(runtime?.properties);
    const configuration = recordFrom(properties?.configuration);
    const azureFile = recordFrom(properties?.azureFile);
    const secrets = configuration?.secrets;
    const firstSecret = Array.isArray(secrets) ? recordFrom(secrets[0]) : undefined;
    const payload = recordFrom(runtime?.payload);

    expect(runtime?.accessToken).toBe("[redacted]");
    expect(firstSecret?.value).toBe("[redacted]");
    expect(azureFile?.accountKey).toBe("[redacted]");
    expect(azureFile?.accountName).toBe("storage-account");
    expect(payload?.data).toBe("[redacted]");
    expect(runtime?.nextPageToken).toBe("page-token-is-not-a-credential");
  });

  test("does not infer state purge confirmation from CLI --yes", async () => {
    let purged = false;
    const result = await runIntent(
      azureDestroyPurgeIntent("cli", "nonInteractive"),
      {
        runners: () =>
          azureRunnerWithStatePurge(() => {
            purged = true;
          }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("runtime.ttyRequired");
      expect(result.error.message).toContain(
        "requires an interactive terminal acknowledgement",
      );
    }
    expect(purged).toBe(false);
  });

  test("purges state only after the typed CLI acknowledgement", async () => {
    let purged = false;
    let promptLabel = "";
    const result = await runIntent(
      azureDestroyPurgeIntent("cli", "interactive"),
      {
        promptText: async (label) => {
          promptLabel = label;
          return "demo";
        },
        runners: () =>
          azureRunnerWithStatePurge(() => {
            purged = true;
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(promptLabel).toContain("Type demo");
    expect(purged).toBe(true);
  });

  test("keeps explicit JSON state purge non-prompting", async () => {
    let prompted = false;
    let purged = false;
    const result = await runIntent(
      azureDestroyPurgeIntent("json", "nonInteractive"),
      {
        promptText: async () => {
          prompted = true;
          return "ignored";
        },
        runners: () =>
          azureRunnerWithStatePurge(() => {
            purged = true;
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(prompted).toBe(false);
    expect(purged).toBe(true);
  });

  test("requires an Azure model endpoint before writing model.default", async () => {
    const result = await runIntent({
      command: "config.set",
      globals: {
        outputMode: "cli",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "auto",
        provider: "azure",
        deployment: "demo",
        providerFields: {
          tenant: "tenant",
          subscription: "subscription",
          "resource-group": "hermes",
          location: "eastus",
          "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
          "storage-name": "hermes",
        },
      },
      key: "model.default",
      value: "gpt-5-mini",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("requires --endpoint");
    }
  });

  test("lowers an Azure model default through the Foundry OpenAI-compatible shape", async () => {
    let capturedPatch: HomeManagerPatch | undefined;
    const result = await runIntent(
      {
        command: "config.set",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "azure",
          deployment: "demo",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
            "resource-group": "hermes",
            location: "eastus",
            "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
            "storage-name": "hermes",
            endpoint: "https://example.openai.azure.com/",
          },
        },
        key: "model.default",
        value: "gpt-5-mini",
      },
      {
        runners: () =>
          azureRunnerCapturingPatch((patch) => {
            capturedPatch = patch;
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedPatch?.section).toBe("model");
    expect(capturedPatch?.block).toContain(
      'provider = lib.mkForce "azure-foundry";',
    );
    expect(capturedPatch?.block).toContain(
      'default = lib.mkForce "gpt-5-mini";',
    );
    expect(capturedPatch?.block).toContain(
      'base_url = lib.mkForce "https://example.openai.azure.com/openai/v1";',
    );
    expect(capturedPatch?.block).toContain(
      'api_mode = lib.mkForce "chat_completions";',
    );
    expect(capturedPatch?.block).not.toContain("auth_mode");
  });

  test("shows Azure managed config content through config show", async () => {
    const managedModule = [
      "{ ... }:",
      "{",
      "programs.hermes-agent.settings.model.default = \"gpt-5-mini\";",
      "}",
    ].join("\n");
    const result = await runIntent(
      {
        command: "config.show",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "azure",
          deployment: "demo",
          providerFields: {
            tenant: "tenant",
            subscription: "subscription",
            "resource-group": "hermes",
            location: "eastus",
            "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
            "storage-name": "hermes",
          },
        },
      },
      {
        runners: () => ({
          ...azureRunnerCapturingPatch(() => undefined),
          readHomeManagerConfig: () =>
            Effect.succeed({
              configured: true,
              managedModuleHash: "hash",
              managedModule,
            }),
        }),
      },
    );

    expect(result.ok).toBe(true);
    const data = result.ok ? recordFrom(result.data) : undefined;
    expect(data?.managedModule).toBe(managedModule);
    expect(renderHuman(result)).toContain(
      "programs.hermes-agent.settings.model.default",
    );
  });

  test("does not expose unsupported Azure Foundry auth mode config", async () => {
    const result = await runIntent({
      command: "config.set",
      globals: {
        outputMode: "cli",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "auto",
        provider: "azure",
        deployment: "demo",
        providerFields: {
          tenant: "tenant",
          subscription: "subscription",
          "resource-group": "hermes",
          location: "eastus",
          "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
          "storage-name": "hermes",
        },
      },
      key: "model.auth_mode",
      value: "entra_id",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not in the supported v1 set");
    }
  });

  test("does not expose Anthropic API mode through the Azure OpenAI-compatible route", async () => {
    const result = await runIntent({
      command: "config.set",
      globals: {
        outputMode: "cli",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "auto",
        provider: "azure",
        deployment: "demo",
        providerFields: {
          tenant: "tenant",
          subscription: "subscription",
          "resource-group": "hermes",
          location: "eastus",
          "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
          "storage-name": "hermes",
        },
      },
      key: "model.api_mode",
      value: "anthropic_messages",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("OpenAI-compatible route");
    }
  });

  test("uses the Azure profile endpoint for model discovery", async () => {
    let capturedTarget: ProviderModelTarget | undefined;
    const profile: AppProfile = {
      provider: "azure",
      name: "default",
      deployment: "demo",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "hermes",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
        openaiCompatibleEndpoint: "https://example.openai.azure.com",
        state: {
          storageName: "hermes",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "models.list",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {},
        },
      },
      {
        profiles: profileStoreFor(profile),
        modelRunners: (target) => {
          capturedTarget = target;
          return {
            listModels: () => Effect.succeed(emptyModelsResult()),
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedTarget?.provider).toBe("azure");
    if (capturedTarget?.provider === "azure") {
      expect(capturedTarget.endpoint).toBe("https://example.openai.azure.com");
    }
  });

  test("rejects cross-provider args when a profile supplies the provider", async () => {
    const profile: AppProfile = {
      provider: "azure",
      name: "default",
      deployment: "demo",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "hermes",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
        state: {
          storageName: "hermes",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "status",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {
            project: "wrong-provider-project",
          },
        },
        watch: false,
      },
      {
        profiles: profileStoreFor(profile),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("--project is not valid");
      expect(result.error.message).toContain("provider azure");
    }

    const statePathResult = await runIntent(
      {
        command: "status",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {
            "state-path": "/exports/hermes",
          },
        },
        watch: false,
      },
      {
        profiles: profileStoreFor(profile),
      },
    );

    expect(statePathResult.ok).toBe(false);
    if (!statePathResult.ok) {
      expect(statePathResult.error.message).toContain("--state-path is not valid");
    }
  });

  test("uses same-provider args as profile-backed command overrides", async () => {
    let capturedTarget: ProviderModelTarget | undefined;
    const profile: AppProfile = {
      provider: "gcp",
      name: "default",
      deployment: "demo",
      user: "user",
      gcp: {
        projectId: "profile-project",
        region: "us-central1",
        state: {
          server: "10.0.0.8",
          dataPath: "/exports/data",
          nixPath: "/exports/nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "models.list",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {
            region: "europe-west4",
            "quota-project": "quota-project",
          },
        },
      },
      {
        profiles: profileStoreFor(profile),
        modelRunners: (target) => {
          capturedTarget = target;
          return {
            listModels: () => Effect.succeed(emptyModelsResult()),
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedTarget?.provider).toBe("gcp");
    if (capturedTarget?.provider === "gcp") {
      expect(capturedTarget.region).toBe("europe-west4");
      expect(capturedTarget.quotaProjectId).toBe("quota-project");
    }
  });

  test("uses profile-backed provider overrides for doctor", async () => {
    let capturedTarget: ProviderModelTarget | undefined;
    const profile: AppProfile = {
      provider: "azure",
      name: "default",
      deployment: "demo",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "hermes",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
        state: {
          storageName: "hermes",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "doctor",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {
            endpoint: "https://example.openai.azure.com",
          },
        },
      },
      {
        profiles: profileStoreFor(profile),
        runners: () => azureRunnerCapturingPatch(() => undefined),
        modelRunners: (target) => {
          capturedTarget = target;
          return {
            listModels: () => Effect.succeed(emptyModelsResult()),
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedTarget?.provider).toBe("azure");
    if (capturedTarget?.provider === "azure") {
      expect(capturedTarget.endpoint).toBe("https://example.openai.azure.com");
    }
  });

  test("keeps a config-provided command target independent of the active profile", () => {
    const activeProfile: AppProfile = {
      provider: "azure",
      name: "work",
      deployment: "work-agent",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "work",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/work/providers/Microsoft.App/managedEnvironments/work",
        state: {
          storageName: "work",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };
    const parsedIntent: Extract<CommandIntent, { readonly command: "status" }> = {
      command: "status",
      globals: {
        config: "deploy.json",
        outputMode: "json",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "never",
        providerFields: {},
      },
      watch: false,
    };
    const configuredIntent: Extract<CommandIntent, { readonly command: "status" }> = {
      ...parsedIntent,
      globals: {
        outputMode: "json",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "never",
        provider: "gcp",
        deployment: "config-agent",
        providerFields: {
          project: "config-project",
          region: "us-central1",
        },
      },
    };

    const resolved = applyActiveProfileDefault(
      parsedIntent,
      configuredIntent,
      { profiles: profileStoreFor(activeProfile) },
    );

    expect("code" in resolved).toBe(false);
    if (!("code" in resolved)) {
      expect(resolved.globals.profile).toBeUndefined();
      expect(resolved.globals.provider).toBe("gcp");
      expect(resolved.globals.deployment).toBe("config-agent");
      expect(resolved.globals.providerFields["project"]).toBe("config-project");
    }
  });

  test("rejects config provider sections that conflict with an explicit provider", () => {
    const intent: Extract<CommandIntent, { readonly command: "status" }> = {
      command: "status",
      globals: {
        provider: "gcp",
        outputMode: "json",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "never",
        providerFields: {},
      },
      watch: false,
    };

    const merged = mergeConfigIntoIntent(intent, {
      deployment: "demo",
      azure: {
        tenant: "tenant",
        subscription: "subscription",
        resourceGroup: "hermes",
      },
    });

    expect("code" in merged).toBe(true);
    if ("code" in merged) {
      expect(merged.code).toBe("config.invalid");
      expect(merged.message).toContain("azure section cannot be used with provider gcp");
    }
  });

  test("does not default JSON commands from the active profile", () => {
    const activeProfile: AppProfile = {
      provider: "gcp",
      name: "work",
      deployment: "work-agent",
      user: "user",
      gcp: {
        projectId: "work-project",
        region: "us-central1",
        state: {
          server: "10.0.0.8",
          dataPath: "/exports/hermes/data",
          nixPath: "/exports/hermes/nix",
        },
      },
    };
    const intent: Extract<CommandIntent, { readonly command: "status" }> = {
      command: "status",
      globals: {
        outputMode: "json",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "never",
        providerFields: {},
      },
      watch: false,
    };

    const resolved = applyActiveProfileDefault(intent, intent, {
      profiles: profileStoreFor(activeProfile),
    });

    expect("code" in resolved).toBe(false);
    if (!("code" in resolved)) {
      expect(resolved.globals.profile).toBeUndefined();
      expect(resolved.globals.provider).toBeUndefined();
      expect(resolved.globals.deployment).toBeUndefined();
    }
  });

  test("defaults non-interactive CLI commands from the active profile", () => {
    const activeProfile: AppProfile = {
      provider: "gcp",
      name: "work",
      deployment: "work-agent",
      user: "user",
      gcp: {
        projectId: "work-project",
        region: "us-central1",
        state: {
          server: "10.0.0.8",
          dataPath: "/exports/hermes/data",
          nixPath: "/exports/hermes/nix",
        },
      },
    };
    const parsed = parseArgs(["status", "--no-input"]);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const resolved = applyActiveProfileDefault(
        parsed.intent,
        parsed.intent,
        {
          profiles: profileStoreFor(activeProfile),
        },
      );

      expect("code" in resolved).toBe(false);
      if (!("code" in resolved)) {
        expect(resolved.globals.profile).toBe("work");
      }
    }
  });

  test("keeps an explicit provider target independent of the active profile", () => {
    const activeProfile: AppProfile = {
      provider: "azure",
      name: "work",
      deployment: "work-agent",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "work",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/work/providers/Microsoft.App/managedEnvironments/work",
        state: {
          storageName: "work",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };
    const intent: Extract<CommandIntent, { readonly command: "status" }> = {
      command: "status",
      globals: {
        outputMode: "cli",
        inputMode: "nonInteractive",
        noBrowser: true,
        debug: false,
        color: "auto",
        provider: "gcp",
        deployment: "direct-agent",
        providerFields: {
          project: "direct-project",
          region: "us-central1",
        },
      },
      watch: false,
    };

    const resolved = applyActiveProfileDefault(intent, intent, {
      profiles: profileStoreFor(activeProfile),
    });

    expect("code" in resolved).toBe(false);
    if (!("code" in resolved)) {
      expect(resolved.globals.profile).toBeUndefined();
      expect(resolved.globals.provider).toBe("gcp");
      expect(resolved.globals.deployment).toBe("direct-agent");
      expect(resolved.globals.providerFields["project"]).toBe("direct-project");
    }
  });

  test("executes explicit provider targets without loading the default profile", async () => {
    const defaultProfile: AppProfile = {
      provider: "azure",
      name: "default",
      deployment: "default-agent",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "default",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/default/providers/Microsoft.App/managedEnvironments/default",
        state: {
          storageName: "default",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };

    let statusProvider = "";
    const statusResult = await runIntent(
      {
        command: "status",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          deployment: "direct-agent",
          providerFields: {
            project: "direct-project",
            region: "us-central1",
          },
        },
        watch: false,
      },
      {
        profiles: profileStoreFor(defaultProfile),
        runners: (target) => {
          statusProvider = target.provider;
          return gcpRunnerCapturingPatch(() => undefined);
        },
      },
    );

    let authProvider = "";
    const authResult = await runIntent(
      {
        command: "auth.check",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          providerFields: {},
        },
      },
      {
        profiles: profileStoreFor(defaultProfile),
        authRunners: (target) => {
          authProvider = target.provider;
          return {
            authCheck: () => Effect.succeed(authSummaryFor(target)),
          };
        },
      },
    );

    let modelProvider = "";
    const modelResult = await runIntent(
      {
        command: "models.list",
        globals: {
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          provider: "gcp",
          providerFields: {
            region: "us-central1",
          },
        },
      },
      {
        profiles: profileStoreFor(defaultProfile),
        modelRunners: (target) => {
          modelProvider = target.provider;
          return {
            listModels: () => Effect.succeed(emptyModelsResult()),
          };
        },
      },
    );

    expect(statusResult.ok).toBe(true);
    expect(statusProvider).toBe("gcp");
    expect(authResult.ok).toBe(true);
    expect(authProvider).toBe("gcp");
    expect(modelResult.ok).toBe(true);
    expect(modelProvider).toBe("gcp");
  });

  test("uses the Azure profile endpoint when setting model.default", async () => {
    let capturedPatch: HomeManagerPatch | undefined;
    const profile: AppProfile = {
      provider: "azure",
      name: "default",
      deployment: "demo",
      user: "user",
      tenantId: "tenant",
      azure: {
        subscriptionId: "subscription",
        resourceGroupName: "hermes",
        location: "eastus",
        environmentId: "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
        openaiCompatibleEndpoint: "https://example.openai.azure.com",
        state: {
          storageName: "hermes",
          dataSubPath: "data",
          nixSubPath: "nix",
        },
      },
    };

    const result = await runIntent(
      {
        command: "config.set",
        globals: {
          profile: "default",
          outputMode: "cli",
          inputMode: "nonInteractive",
          noBrowser: true,
          debug: false,
          color: "auto",
          providerFields: {},
        },
        key: "model.default",
        value: "gpt-5-mini",
      },
      {
        profiles: profileStoreFor(profile),
        runners: () =>
          azureRunnerCapturingPatch((patch) => {
            capturedPatch = patch;
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedPatch?.block).toContain(
      'base_url = lib.mkForce "https://example.openai.azure.com/openai/v1";',
    );
  });
});

describe("human rendering", () => {
  test("renders read-only list data instead of only summaries", () => {
    const output = renderHuman({
      ok: true,
      command: "models.list",
      summary: "gcp profile default found 1 supported models.",
      data: [
        {
          id: "gemini-3-flash",
          route: "gemini/developer-api",
          runtimeTarget: "model-id",
        },
      ],
    });

    expect(output).toContain(
      "gemini-3-flash (gemini/developer-api; use model id)",
    );
  });

  test("renders Azure catalog models as deployment-name inputs", () => {
    const output = renderHuman({
      ok: true,
      command: "models.list",
      summary:
        "azure profile default found 1 model catalog entries. Configure Hermes with an Azure deployment name.",
      data: [
        {
          id: "gpt-5-mini",
          route: "azure-foundry/openai-compatible",
          runtimeTarget: "deployment-name",
        },
      ],
    });

    expect(output).toContain(
      "gpt-5-mini (azure-foundry/openai-compatible; configure deployment name)",
    );
  });

  test("renders doctor checks", () => {
    const output = renderHuman({
      ok: true,
      command: "doctor",
      summary: "Doctor checked gcp profile default: 1 passed, 0 failed, 0 skipped.",
      data: {
        checks: [
          {
            name: "runtime",
            status: "passed",
            message: "Non-interactive mode will not prompt or open a browser.",
          },
        ],
      },
    });

    expect(output).toContain(
      "passed runtime: Non-interactive mode will not prompt or open a browser.",
    );
  });

  test("renders safe auth check details", () => {
    const output = renderHuman({
      ok: true,
      command: "auth.check",
      summary: "azure profile default can authenticate.",
      data: {
        tenantId: "tenant",
        subscriptionId: "subscription",
        expiresAtEpochSeconds: 1_800_000_000,
        boundaryChecked: true,
      },
    });

    expect(output).toContain("tenant: tenant");
    expect(output).toContain("subscription: subscription");
    expect(output).toContain("token expires: 2027-01-15T08:00:00.000Z");
    expect(output).toContain("boundary checked: true");
    expect(output).not.toContain("Bearer");
  });

  test("renders status runtime and config details", () => {
    const output = renderHuman({
      ok: true,
      command: "status",
      summary: "azure container-app demo is deployed.",
      data: {
        runtime: {
          deployed: true,
          endpoint: "demo.example",
          image: "example/hermes:1",
          latestRevision: "rev",
        },
        config: {
          configured: true,
          managedModuleHash: "abc123",
        },
      },
    });

    expect(output).toContain("endpoint: demo.example");
    expect(output).toContain("managed config: present");
    expect(output).toContain("managed config hash: abc123");
  });

  test("renders setup profile boundary and next step", () => {
    const output = renderHuman({
      ok: true,
      command: "setup",
      summary: "Profile work saved for azure deployment work-agent.",
      data: {
        provider: "azure",
        name: "work",
        deployment: "work-agent",
        user: "user",
        tenantId: "tenant",
        azure: {
          subscriptionId: "subscription",
          resourceGroupName: "hermes",
          location: "eastus",
          environmentId: "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
          state: {
            storageName: "hermes",
            dataSubPath: "data",
            nixSubPath: "nix",
          },
        },
      },
    });

    expect(output).toContain("profile: work");
    expect(output).toContain(
      "boundary: subscription subscription, resource group hermes, location eastus",
    );
    expect(output).toContain("next: hermes-ambit deploy --profile work");
  });
});
