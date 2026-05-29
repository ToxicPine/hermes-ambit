import { describe, expect, test } from "bun:test";

import type { AppProfile } from "../src/app-profile.js";
import type { CommandRuntime } from "../src/command.js";
import type { ProfileStore } from "../src/profile-store.js";
import { tuiLaunchContext } from "../src/tui-launch.js";
import type { CommandIntent, GlobalOptions } from "../src/types.js";

const activeAzureProfile: AppProfile = {
  provider: "azure",
  name: "work",
  deployment: "work-agent",
  user: "user",
  tenantId: "tenant",
  azure: {
    subscriptionId: "subscription",
    resourceGroupName: "work",
    location: "eastus",
    environmentId:
      "/subscriptions/subscription/resourceGroups/work/providers/Microsoft.App/managedEnvironments/work",
    state: {
      storageName: "work",
      dataSubPath: "data",
      nixSubPath: "nix",
    },
  },
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

const globals = (input: Partial<GlobalOptions> = {}): GlobalOptions => ({
  outputMode: "tui",
  inputMode: "interactive",
  noBrowser: false,
  debug: false,
  color: "auto",
  providerFields: {},
  ...input,
});

const tuiIntent = (
  input: Partial<GlobalOptions> = {},
): Extract<CommandIntent, { readonly command: "tui" }> => ({
  command: "tui",
  globals: globals(input),
  explicit: true,
});

describe("TUI launch context", () => {
  test("loads the active profile when launch has no explicit target input", () => {
    const runtime: CommandRuntime = {
      profiles: profileStoreFor(activeAzureProfile),
    };

    const context = tuiLaunchContext(tuiIntent(), runtime);

    expect(context.profileName).toBe("work");
    expect(context.profile?.provider).toBe("azure");
    expect(context.setupDraft.provider).toBe("azure");
    expect(context.setupDraft.deployment).toBe("work-agent");
  });

  test("keeps explicit launch input independent of the active profile", () => {
    const runtime: CommandRuntime = {
      profiles: profileStoreFor(activeAzureProfile),
    };

    const context = tuiLaunchContext(
      tuiIntent({
        provider: "gcp",
        deployment: "direct-agent",
        providerFields: {
          project: "direct-project",
          region: "us-central1",
        },
      }),
      runtime,
    );

    expect(context.profile).toBeUndefined();
    expect(context.profileError).toBeUndefined();
    expect(context.profileName).toBe("default");
    expect(context.setupDraft.provider).toBe("gcp");
    expect(context.setupDraft.deployment).toBe("direct-agent");
    expect(context.setupDraft.fields["project"]).toBe("direct-project");
    expect(context.setupDraft.fields["resource-group"]).toBeUndefined();
  });

  test("uses explicit profile launch input as an editable target overlay", () => {
    const runtime: CommandRuntime = {
      profiles: profileStoreFor(activeAzureProfile),
    };

    const context = tuiLaunchContext(
      tuiIntent({
        profile: "work",
        providerFields: {
          endpoint: "https://work.openai.azure.com",
          location: "westus3",
        },
      }),
      runtime,
    );

    expect(context.profile).toBeUndefined();
    expect(context.provider).toBe("azure");
    expect(context.profileName).toBe("work");
    expect(context.setupDraft.provider).toBe("azure");
    expect(context.setupDraft.deployment).toBe("work-agent");
    expect(context.setupDraft.fields["subscription"]).toBe("subscription");
    expect(context.setupDraft.fields["resource-group"]).toBe("work");
    expect(context.setupDraft.fields["location"]).toBe("westus3");
    expect(context.setupDraft.fields["endpoint"]).toBe(
      "https://work.openai.azure.com",
    );
  });
});
