import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import {
  CloudLog,
  HERMES_CONTAINER_NAME,
  RUNTIME_SECRET_NAME_MESSAGE,
  UNIVERSAL_HERMES_IMAGE,
  type CloudEvent,
} from "@cardelli/shared";

import {
  containerAppMatchesInput,
  desiredContainerApp,
  mergeContainerAppInput,
} from "../src/container-apps.js";
import { waitAzureLongRunningOperation } from "../src/client.js";
import { makeAzureDriver, type AzureDeployment } from "../src/deployment.js";
import {
  purgeAzureDeploymentState,
  readAzureHomeManagerConfig,
  updateAzureHomeManager,
} from "../src/home-manager.js";
import { requireAzureDeploymentStateStorage } from "../src/environment-storage.js";
import { azureFoundryOpenAICompatibleModelsUrl } from "../src/models.js";
import {
  deleteAzureRuntimeSecret,
  listAzureRuntimeSecrets,
  putAzureRuntimeSecret,
} from "../src/runtime-secrets.js";
import { readContainerAppSecrets } from "../src/secrets.js";
import type { ContainerApp } from "../src/generated/container-apps/model/containerApp.js";

const auth = {
  token: () =>
    Effect.succeed({
      accessToken: "token",
      expiresAtEpochSeconds: 1,
      subscriptionId: "subscription",
      tenantId: "tenant",
    }),
};

const deployment: AzureDeployment = {
  name: "demo",
  subscriptionId: "subscription",
  resourceGroupName: "resource-group",
  location: "eastus",
  environmentId:
    "/subscriptions/subscription/resourceGroups/resource-group/providers/Microsoft.App/managedEnvironments/environment",
  state: {
    storageName: "state",
    dataSubPath: "data",
    nixSubPath: "nix",
  },
};

describe("Azure deployment planning", () => {
  test("rejects invalid deployment identities before deriving cloud names", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        makeAzureDriver(auth).plan({
          ...deployment,
          name: "Demo_Agent",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("Deployment names must start");
      expect(result.left.message).not.toContain("UNIVERSAL_HERMES_IMAGE");
    }
  });

  test("plans a create with the universal runtime image", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      seenRequests.push(url);
      return new Response("{}", {
        status: url.includes("/storages/") ? 200 : 404,
      });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(makeAzureDriver(auth).plan(deployment)),
      );

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.action).toBe("create");
        expect(
          result.right.containerApp.properties?.template?.containers?.find(
            (container) => container.name === HERMES_CONTAINER_NAME,
          )?.image,
        ).toBe(UNIVERSAL_HERMES_IMAGE);
      }
      expect(seenRequests.some((url) => url.includes("/storages/"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects incomplete Azure Files state before cloud reads", async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          makeAzureDriver(auth).plan({
            ...deployment,
            state: {
              storageName: "",
              dataSubPath: deployment.state.dataSubPath,
              nixSubPath: deployment.state.nixSubPath,
            },
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain(
          "non-empty environment storage name",
        );
        expect(result.left.message).not.toContain("UNIVERSAL_HERMES_IMAGE");
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires the named Container Apps environment storage for durable state", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response("{}", { status: 404 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(requireAzureDeploymentStateStorage(auth, deployment)),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("RemediationRequired");
        expect(result.left.message).toContain("environment storage must exist");
        if (result.left._tag === "RemediationRequired") {
          expect(result.left.remediation.type).toBe("url");
        }
      }
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).toContain(
        "/managedEnvironments/environment/storages/state",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires the managed environment to stay inside the selected Azure boundary", async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          requireAzureDeploymentStateStorage(auth, {
            ...deployment,
            environmentId:
              "/subscriptions/other/resourceGroups/other/providers/Microsoft.App/managedEnvironments/environment",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("OperationFailed");
        expect(result.left.message).toContain(
          "selected subscription and resource group",
        );
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails restart when the Container App is absent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    try {
      const result = await Effect.runPromise(
        Effect.either(makeAzureDriver(auth).restart(deployment)),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("must be deployed");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not attach a managed identity unless the deployment needs one", () => {
    const desired = desiredContainerApp({
      identity: deployment,
      location: deployment.location,
      environmentId: deployment.environmentId,
      state: deployment.state,
    });
    const current = {
      ...desired,
      identity: {
        type: "SystemAssigned",
        principalId: "principal-id",
        tenantId: "tenant-id",
      },
    } satisfies ContainerApp;

    expect(desired.identity).toBeUndefined();
    expect(containerAppMatchesInput(current, desired)).toBe(true);
  });

  test("keeps existing user-assigned identities when reconciling the app", () => {
    const desired = desiredContainerApp({
      identity: deployment,
      location: deployment.location,
      environmentId: deployment.environmentId,
      state: deployment.state,
    });
    const current = {
      ...desired,
      identity: {
        type: "SystemAssigned,UserAssigned",
        principalId: "principal-id",
        tenantId: "tenant-id",
        userAssignedIdentities: {
          "/subscriptions/subscription/resourceGroups/resource-group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/model-access":
            {
              clientId: "client-id",
              principalId: "principal-id",
            },
        },
      },
    } satisfies ContainerApp;

    const merged = mergeContainerAppInput(desired, current);

    expect(containerAppMatchesInput(current, desired)).toBe(true);
    expect(desired.identity).toBeUndefined();
    expect(merged.identity?.type).toBe("SystemAssigned,UserAssigned");
    expect(Object.keys(merged.identity?.userAssignedIdentities ?? {})).toEqual([
      "/subscriptions/subscription/resourceGroups/resource-group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/model-access",
    ]);
  });

  test("rejects secret reads when the named Container App is not owned by the deployment", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response(
        JSON.stringify({
          id: "container-app-id",
          location: deployment.location,
          tags: {
            "hermes-managed-scope": "hermes-ambit.azure",
            "hermes-managed-deployment": "hermes-other",
          },
        }),
        { status: 200 },
      );
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          readContainerAppSecrets(auth, {
            subscriptionId: deployment.subscriptionId,
            resourceGroupName: deployment.resourceGroupName,
            containerAppName: "hermes-demo",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("already used");
      }
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).not.toContain("listSecrets");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists configured runtime secret names without invoking Azure secret value listing", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response(
        JSON.stringify({
          id: "container-app-id",
          location: deployment.location,
          tags: {
            "hermes-managed-scope": "azure",
            "hermes-managed-deployment": "hermes-demo",
          },
          properties: {
            configuration: {
              secrets: [
                { name: "azure-foundry-api-key" },
                { name: "registry-password" },
              ],
            },
            template: {
              containers: [
                {
                  name: "hermes",
                  env: [
                    {
                      name: "AZURE_FOUNDRY_API_KEY",
                      secretRef: "azure-foundry-api-key",
                    },
                    {
                      name: "REGISTRY_PASSWORD",
                      value: "not-secret-ref",
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    };

    try {
      const result = await Effect.runPromise(
        listAzureRuntimeSecrets(auth, deployment),
      );

      expect(result).toEqual(["AZURE_FOUNDRY_API_KEY"]);
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).not.toContain("listSecrets");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects invalid runtime secret names before cloud requests", async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          putAzureRuntimeSecret(auth, {
            ...deployment,
            runtimeName: "azure-foundry-api-key",
            value: "secret-value",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toBe(RUNTIME_SECRET_NAME_MESSAGE);
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects runtime secret wiring when the Hermes container is missing", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seenRequests.push({ url, method });
      return new Response(
        JSON.stringify({
          id: "container-app-id",
          name: "hermes-demo",
          location: deployment.location,
          tags: {
            "hermes-managed-scope": "azure",
            "hermes-managed-deployment": "hermes-demo",
          },
          properties: {
            configuration: {
              secrets: [],
            },
            template: {
              containers: [{ name: "sidecar" }],
            },
          },
        }),
        { status: 200 },
      );
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          putAzureRuntimeSecret(auth, {
            ...deployment,
            runtimeName: "AZURE_FOUNDRY_API_KEY",
            value: "secret-value",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("Hermes container");
      }
      expect(seenRequests.length).toBe(1);
      expect(
        seenRequests.some(
          (request) =>
            request.url.includes("/containerApps/hermes-demo") &&
            request.method === "PUT",
        ),
      ).toBe(false);
      expect(
        seenRequests.some((request) => request.url.includes("/stop")),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sets runtime secret config and environment in one Container App update", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
      readonly body: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const app = {
      id: "container-app-id",
      name: "hermes-demo",
      location: deployment.location,
      tags: {
        "hermes-managed-scope": "azure",
        "hermes-managed-deployment": "hermes-demo",
      },
      properties: {
        configuration: {
          secrets: [],
        },
        template: {
          containers: [{ name: "hermes", env: [] }],
        },
      },
    };

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      seenRequests.push({ url, method, body });
      return new Response(JSON.stringify(app), { status: 200 });
    };

    try {
      await Effect.runPromise(
        putAzureRuntimeSecret(auth, {
          ...deployment,
          runtimeName: "AZURE_FOUNDRY_API_KEY",
          value: "secret-value",
        }),
      );

      const updates = seenRequests.filter(
        (request) =>
          request.url.includes("/containerApps/hermes-demo") &&
          request.method === "PUT",
      );

      expect(updates.length).toBe(1);
      expect(updates[0]?.body).toContain('"name":"azure-foundry-api-key"');
      expect(updates[0]?.body).toContain('"secretRef":"azure-foundry-api-key"');
      expect(updates[0]?.body).toContain('"name":"AZURE_FOUNDRY_API_KEY"');

      const update = seenRequests.findIndex(
        (request) =>
          request.url.includes("/containerApps/hermes-demo") &&
          request.method === "PUT",
      );
      const stop = seenRequests.findIndex(
        (request) =>
          request.url.includes("/containerApps/hermes-demo/stop") &&
          request.method === "POST",
      );
      const start = seenRequests.findIndex(
        (request) =>
          request.url.includes("/containerApps/hermes-demo/start") &&
          request.method === "POST",
      );

      expect(stop).toBeGreaterThan(update);
      expect(start).toBeGreaterThan(stop);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removes runtime secret config and environment in one Container App update", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
      readonly body: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const appWithSecret = {
      id: "container-app-id",
      name: "hermes-demo",
      location: deployment.location,
      tags: {
        "hermes-managed-scope": "azure",
        "hermes-managed-deployment": "hermes-demo",
      },
      properties: {
        configuration: {
          secrets: [{ name: "azure-foundry-api-key" }],
        },
        template: {
          containers: [
            {
              name: "hermes",
              env: [
                {
                  name: "AZURE_FOUNDRY_API_KEY",
                  secretRef: "azure-foundry-api-key",
                },
              ],
            },
          ],
        },
      },
    };
    const appWithoutSecret = {
      ...appWithSecret,
      properties: {
        ...appWithSecret.properties,
        configuration: {
          ...appWithSecret.properties.configuration,
          secrets: [],
        },
        template: {
          ...appWithSecret.properties.template,
          containers: [{ name: "hermes", env: [] }],
        },
      },
    };

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      seenRequests.push({ url, method, body });

      if (method === "PUT") {
        return new Response(JSON.stringify(appWithoutSecret), { status: 200 });
      }
      return new Response(JSON.stringify(appWithSecret), { status: 200 });
    };

    try {
      await Effect.runPromise(
        deleteAzureRuntimeSecret(auth, {
          ...deployment,
          runtimeName: "AZURE_FOUNDRY_API_KEY",
        }),
      );

      const updates = seenRequests.filter(
        (request) =>
          request.url.includes("/containerApps/hermes-demo") &&
          request.method === "PUT",
      );

      expect(updates.length).toBe(1);
      expect(updates[0]?.body).toContain('"secrets":[]');
      expect(updates[0]?.body).toContain('"env":[]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects config updates before touching storage when the Container App is absent", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response("{}", { status: 404 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          updateAzureHomeManager(auth, auth, {
            identity: deployment,
            user: "user",
            module:
              '{ lib, ... }:\n{\n  programs.hermes-agent.settings.model.default = "gpt-5";\n}\n',
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("must be deployed");
      }
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).toContain("management.azure.com");
      expect(seenRequests[0]).not.toContain("file.core.windows.net");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports missing config without touching storage when the Container App is absent", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response("{}", { status: 404 });
    };

    try {
      const result = await Effect.runPromise(
        readAzureHomeManagerConfig(auth, auth, deployment, "user"),
      );

      expect(result).toBeUndefined();
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).toContain("management.azure.com");
      expect(seenRequests[0]).not.toContain("file.core.windows.net");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves Azure Files state before deleting the Container App during purge", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seenRequests.push({ url, method });
      return new Response("{}", { status: 404 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(purgeAzureDeploymentState(auth, auth, deployment)),
      );

      expect(Either.isLeft(result)).toBe(true);
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]?.url).toContain(
        "/managedEnvironments/environment",
      );
      expect(
        seenRequests.some(
          (request) =>
            request.url.includes("/containerApps/hermes-demo") &&
            request.method === "DELETE",
        ),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Azure Foundry model catalog", () => {
  test("builds the models URL from either resource endpoint or runtime base URL", () => {
    expect(
      azureFoundryOpenAICompatibleModelsUrl("https://example.openai.azure.com"),
    ).toBe(
      "https://example.openai.azure.com/openai/models?api-version=2024-10-21",
    );
    expect(
      azureFoundryOpenAICompatibleModelsUrl(
        "https://example.openai.azure.com/openai/v1/",
      ),
    ).toBe(
      "https://example.openai.azure.com/openai/models?api-version=2024-10-21",
    );
  });
});

describe("Azure operation polling", () => {
  test("emits Azure operation identity while waiting", async () => {
    const operationUrl =
      "https://management.azure.com/subscriptions/subscription/providers/Microsoft.App/locations/eastus/operationStatuses/operation-1";
    const events: CloudEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "Succeeded" }), { status: 200 });

    try {
      await Effect.runPromise(
        Effect.provideService(
          waitAzureLongRunningOperation(
            auth,
            "azure.containerApps.createOrUpdate",
            {
              headers: new Headers({ "Azure-AsyncOperation": operationUrl }),
            },
          ),
          CloudLog,
          {
            emit: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(events.map((event) => event.message)).toEqual([
      "Waiting for Azure operation",
      "Azure operation completed",
    ]);
    expect(events.map((event) => event.resource)).toEqual([
      operationUrl,
      operationUrl,
    ]);
  });
});
