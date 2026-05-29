import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import {
  CloudLog,
  HERMES_CONTAINER_NAME,
  RUNTIME_SECRET_NAME_MESSAGE,
  type CloudEvent,
} from "@cardelli/shared";

import {
  gcpLabels,
  makeGcpDriver,
  type GcpDeployment,
} from "../src/deployment.js";
import { waitForCloudRunMutation } from "../src/cloud-run-operations.js";
import { desiredCloudRunService } from "../src/cloud-run.js";
import { GoogleCloudRunV2ServiceIngress } from "../src/generated/run/model/googleCloudRunV2ServiceIngress.js";
import {
  deleteGcpRuntimeSecret,
  listGcpRuntimeSecrets,
  putGcpRuntimeSecret,
} from "../src/runtime-secrets.js";
import { updateGcpHomeManager } from "../src/home-manager.js";
import {
  gcpServiceAccountMember,
  putSecretValue,
  withSecretAccessorMember,
} from "../src/secret-manager.js";

const auth = {
  token: () => Effect.succeed({ accessToken: "token" }),
};

const deployment: GcpDeployment = {
  name: "demo",
  projectId: "project",
  region: "us-central1",
  state: {
    server: "10.0.0.1",
    dataPath: "/exports/data",
    nixPath: "/exports/nix",
  },
};

describe("GCP deployment planning", () => {
  test("rejects invalid deployment identities before deriving cloud names", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        makeGcpDriver(auth).plan({
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

  test("fails before cloud mutation while the universal image is a placeholder", async () => {
    const result = await Effect.runPromise(
      Effect.either(makeGcpDriver(auth).plan(deployment)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("UNIVERSAL_HERMES_IMAGE");
    }
  });

  test("rejects incomplete NFS state before the image gate", async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          makeGcpDriver(auth).plan({
            ...deployment,
            state: {
              server: "",
              dataPath: deployment.state.dataPath,
              nixPath: deployment.state.nixPath,
            },
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("non-empty NFS server");
        expect(result.left.message).not.toContain("UNIVERSAL_HERMES_IMAGE");
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails restart when the Cloud Run service is absent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    try {
      const result = await Effect.runPromise(
        Effect.either(makeGcpDriver(auth).restart(deployment)),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("must be deployed");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("attaches a requested runtime service account to Cloud Run", () => {
    const service = desiredCloudRunService({
      identity: deployment,
      projectId: deployment.projectId,
      region: deployment.region,
      state: deployment.state,
      serviceAccount: "hermes-runtime@project.iam.gserviceaccount.com",
    });

    expect(service.template?.serviceAccount).toBe(
      "hermes-runtime@project.iam.gserviceaccount.com",
    );
  });

  test("makes the Cloud Run endpoint public without IAM invoker setup", () => {
    const service = desiredCloudRunService({
      identity: deployment,
      projectId: deployment.projectId,
      region: deployment.region,
      state: deployment.state,
    });

    expect(service.ingress).toBe(
      GoogleCloudRunV2ServiceIngress.INGRESS_TRAFFIC_ALL,
    );
    expect(service.invokerIamDisabled).toBe(true);
  });

  test("adds Secret Manager accessor permission idempotently", () => {
    const member = gcpServiceAccountMember(
      "hermes-runtime@project.iam.gserviceaccount.com",
    );
    const first = withSecretAccessorMember({}, member);
    const second = withSecretAccessorMember(first, member);

    expect(first.bindings).toEqual([
      {
        role: "roles/secretmanager.secretAccessor",
        members: [member],
      },
    ]);
    expect(second).toBe(first);
  });

  test("rejects secret updates when the generated secret name is not owned by the deployment", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response(
        JSON.stringify({
          secrets: [
            {
              name: "projects/project/secrets/hermes-demo-google-api-key",
              replication: { automatic: {} },
              labels: {
                "hermes-managed-scope": "hermes-ambit.gcp",
                "hermes-managed-deployment": "hermes-other",
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          putSecretValue(auth, {
            projectId: deployment.projectId,
            secretId: "hermes-demo-google-api-key",
            value: "secret",
            owner: { name: deployment.name },
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("already used");
      }
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).toContain("secretmanager.googleapis.com");
      expect(seenRequests[0]).not.toContain(":addVersion");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists only runtime secrets wired into the Hermes container", async () => {
    const seenRequests: URL[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(new URL(String(input)));
      return new Response(
        JSON.stringify({
          name: "projects/project/locations/us-central1/services/hermes-demo",
          labels: {
            "hermes-managed-scope": "gcp",
            "hermes-managed-deployment": "hermes-demo",
          },
          template: {
            containers: [
              {
                name: HERMES_CONTAINER_NAME,
                env: [
                  {
                    name: "GOOGLE_API_KEY",
                    valueSource: {
                      secretKeyRef: {
                        secret: "hermes-demo-google-api-key",
                        version: "latest",
                      },
                    },
                  },
                  {
                    name: "REGISTRY_PASSWORD",
                    value: "not-secret-ref",
                  },
                  {
                    name: "UNWIRED_SECRET",
                    valueSource: {
                      secretKeyRef: {
                        secret: "hermes-demo-other",
                        version: "latest",
                      },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    };

    try {
      const result = await Effect.runPromise(
        listGcpRuntimeSecrets(auth, deployment),
      );

      expect(result).toEqual(["GOOGLE_API_KEY"]);
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]?.hostname).toBe("run.googleapis.com");
      expect(seenRequests[0]?.hostname).not.toBe(
        "secretmanager.googleapis.com",
      );
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
          putGcpRuntimeSecret(auth, {
            ...deployment,
            runtimeName: "google-api-key",
            value: "secret",
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

  test("requires an explicit Cloud Run service account before wiring runtime secrets", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const service = {
      name: "projects/project/locations/us-central1/services/hermes-demo",
      labels: {
        "hermes-managed-scope": "gcp",
        "hermes-managed-deployment": "hermes-demo",
      },
      template: {
        containers: [
          {
            name: HERMES_CONTAINER_NAME,
            image: "example/hermes:latest",
          },
        ],
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seenRequests.push({ url, method });

      return url.includes("run.googleapis.com") && method === "GET"
        ? new Response(JSON.stringify(service), { status: 200 })
        : new Response("{}", { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          putGcpRuntimeSecret(auth, {
            ...deployment,
            runtimeName: "GOOGLE_API_KEY",
            value: "secret",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("RemediationRequired");
        expect(result.left.message).toContain("explicit service account");
      }
      expect(
        seenRequests.some((request) =>
          request.url.includes("secretmanager.googleapis.com"),
        ),
      ).toBe(false);
      expect(
        seenRequests.some(
          (request) =>
            request.url.includes("run.googleapis.com") &&
            request.method === "PATCH",
        ),
      ).toBe(false);
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
    const service = {
      name: "projects/project/locations/us-central1/services/hermes-demo",
      labels: {
        "hermes-managed-scope": "gcp",
        "hermes-managed-deployment": "hermes-demo",
      },
      template: {
        serviceAccount: "hermes-runtime@project.iam.gserviceaccount.com",
        containers: [
          {
            name: "sidecar",
            image: "example/sidecar:1",
          },
        ],
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seenRequests.push({ url, method });

      return url.includes("run.googleapis.com") && method === "GET"
        ? new Response(JSON.stringify(service), { status: 200 })
        : new Response("{}", { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          putGcpRuntimeSecret(auth, {
            ...deployment,
            runtimeName: "GOOGLE_API_KEY",
            value: "secret",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("Hermes container");
      }
      expect(
        seenRequests.some((request) =>
          request.url.includes("secretmanager.googleapis.com"),
        ),
      ).toBe(false);
      expect(
        seenRequests.some(
          (request) =>
            request.url.includes("run.googleapis.com") &&
            request.method === "PATCH",
        ),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rolls a Cloud Run revision after updating a runtime secret value", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
      readonly body: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const serviceAccount = "hermes-runtime@project.iam.gserviceaccount.com";
    const service = {
      name: "projects/project/locations/us-central1/services/hermes-demo",
      labels: {
        "hermes-managed-scope": "gcp",
        "hermes-managed-deployment": "hermes-demo",
      },
      template: {
        serviceAccount,
        containers: [
          {
            name: HERMES_CONTAINER_NAME,
            image: "example/hermes:latest",
            env: [
              {
                name: "GOOGLE_API_KEY",
                valueSource: {
                  secretKeyRef: {
                    secret: "hermes-demo-google-api-key",
                    version: "latest",
                  },
                },
              },
            ],
          },
        ],
      },
    };

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      seenRequests.push({ url, method, body });

      if (url.includes("run.googleapis.com") && method === "GET") {
        return new Response(JSON.stringify(service), { status: 200 });
      }
      if (url.includes("run.googleapis.com") && method === "PATCH") {
        return new Response(JSON.stringify({ name: "operation", done: true }), {
          status: 200,
        });
      }
      if (url.includes(":getIamPolicy")) {
        return new Response(
          JSON.stringify({
            bindings: [
              {
                role: "roles/secretmanager.secretAccessor",
                members: [gcpServiceAccountMember(serviceAccount)],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(":addVersion")) {
        return new Response(
          JSON.stringify({
            name: "projects/project/secrets/hermes-demo-google-api-key/versions/2",
          }),
          { status: 200 },
        );
      }
      if (url.includes("secretmanager.googleapis.com") && method === "GET") {
        return new Response(
          JSON.stringify({
            secrets: [
              {
                name: "projects/project/secrets/hermes-demo-google-api-key",
                replication: { automatic: {} },
                labels: {
                  "hermes-managed-scope": "gcp",
                  "hermes-managed-deployment": "hermes-demo",
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    try {
      await Effect.runPromise(
        putGcpRuntimeSecret(auth, {
          ...deployment,
          runtimeName: "GOOGLE_API_KEY",
          value: "rotated-secret",
        }),
      );

      const secretVersion = seenRequests.findIndex((request) =>
        request.url.includes(":addVersion"),
      );
      const environmentPatch = seenRequests.findIndex((request) => {
        if (
          !request.url.includes("run.googleapis.com") ||
          request.method !== "PATCH"
        ) {
          return false;
        }
        const params = new URL(request.url).searchParams;
        return (
          params.get("updateMask") === "template" &&
          params.get("forceNewRevision") === "true" &&
          request.body.includes('"name":"GOOGLE_API_KEY"') &&
          request.body.includes('"version":"latest"')
        );
      });
      const cloudRunPatches = seenRequests.filter(
        (request) =>
          request.url.includes("run.googleapis.com") &&
          request.method === "PATCH",
      );

      expect(secretVersion).toBeGreaterThan(-1);
      expect(environmentPatch).toBeGreaterThan(secretVersion);
      expect(cloudRunPatches).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not delete provider secrets when the runtime service is absent", async () => {
    const seenRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seenRequests.push(String(input));
      return new Response("{}", { status: 404 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          deleteGcpRuntimeSecret(auth, {
            ...deployment,
            runtimeName: "GOOGLE_API_KEY",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("must be deployed");
      }
      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0]).toContain("run.googleapis.com");
      expect(seenRequests[0]).not.toContain("secretmanager.googleapis.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unwires runtime environment before deleting the provider secret", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
      readonly body: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const service = {
      name: "projects/project/locations/us-central1/services/hermes-demo",
      labels: {
        "hermes-managed-scope": "gcp",
        "hermes-managed-deployment": "hermes-demo",
      },
      template: {
        containers: [
          {
            name: HERMES_CONTAINER_NAME,
            env: [
              {
                name: "GOOGLE_API_KEY",
                valueSource: {
                  secretKeyRef: {
                    secret: "hermes-demo-google-api-key",
                    version: "latest",
                  },
                },
              },
            ],
          },
        ],
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      seenRequests.push({ url, method, body });

      if (url.includes("run.googleapis.com") && method === "GET") {
        return new Response(JSON.stringify(service), { status: 200 });
      }
      if (url.includes("run.googleapis.com") && method === "PATCH") {
        return new Response(JSON.stringify({ name: "operation", done: true }), {
          status: 200,
        });
      }
      if (url.includes("secretmanager.googleapis.com") && method === "GET") {
        return new Response(
          JSON.stringify({
            secrets: [
              {
                name: "projects/project/secrets/hermes-demo-google-api-key",
                replication: { automatic: {} },
                labels: {
                  "hermes-managed-scope": "gcp",
                  "hermes-managed-deployment": "hermes-demo",
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("secretmanager.googleapis.com") && method === "DELETE") {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    try {
      await Effect.runPromise(
        deleteGcpRuntimeSecret(auth, {
          ...deployment,
          runtimeName: "GOOGLE_API_KEY",
        }),
      );

      const firstServicePatch = seenRequests.findIndex(
        (request) =>
          request.url.includes("run.googleapis.com") &&
          request.method === "PATCH",
      );
      const secretDelete = seenRequests.findIndex(
        (request) =>
          request.url.includes("secretmanager.googleapis.com") &&
          request.method === "DELETE",
      );

      expect(firstServicePatch).toBeGreaterThan(-1);
      expect(secretDelete).toBeGreaterThan(firstServicePatch);
      expect(
        new URL(seenRequests[firstServicePatch]?.url ?? "").searchParams.get(
          "forceNewRevision",
        ),
      ).toBe("true");
      expect(seenRequests[firstServicePatch]?.body).not.toContain(
        "GOOGLE_API_KEY",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deletes owned runtime secrets after deleting the Cloud Run service", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const service = {
      name: "projects/project/locations/us-central1/services/hermes-demo",
      labels: gcpLabels(deployment),
      template: {
        containers: [
          {
            name: HERMES_CONTAINER_NAME,
            env: [
              {
                name: "GOOGLE_API_KEY",
                valueSource: {
                  secretKeyRef: {
                    secret: "hermes-demo-google-api-key",
                    version: "latest",
                  },
                },
              },
              {
                name: "UNRELATED_SECRET",
                valueSource: {
                  secretKeyRef: {
                    secret: "manually-owned-secret",
                    version: "latest",
                  },
                },
              },
            ],
          },
        ],
      },
    };

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seenRequests.push({ url, method });

      if (url.includes("/services/hermes-demo") && method === "GET") {
        return new Response(JSON.stringify(service), { status: 200 });
      }
      if (url.includes("/jobs/hm-demo") && method === "GET") {
        return new Response("{}", { status: 404 });
      }
      if (url.includes("/services/hermes-demo") && method === "DELETE") {
        return new Response(JSON.stringify({ name: "operation", done: true }), {
          status: 200,
        });
      }
      if (url.includes("secretmanager.googleapis.com") && method === "GET") {
        return new Response(
          JSON.stringify({
            secrets: [
              {
                name: "projects/project/secrets/hermes-demo-google-api-key",
                replication: { automatic: {} },
                labels: gcpLabels(deployment),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("secretmanager.googleapis.com") && method === "DELETE") {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    try {
      await Effect.runPromise(makeGcpDriver(auth).destroy(deployment));

      const serviceDelete = seenRequests.findIndex(
        (request) =>
          request.url.includes("run.googleapis.com") &&
          request.url.includes("/services/hermes-demo") &&
          request.method === "DELETE",
      );
      const secretDelete = seenRequests.findIndex(
        (request) =>
          request.url.includes("secretmanager.googleapis.com") &&
          request.url.includes("/secrets/hermes-demo-google-api-key") &&
          request.method === "DELETE",
      );
      const unrelatedSecretDelete = seenRequests.findIndex(
        (request) =>
          request.url.includes("secretmanager.googleapis.com") &&
          request.url.includes("/secrets/manually-owned-secret") &&
          request.method === "DELETE",
      );

      expect(serviceDelete).toBeGreaterThan(-1);
      expect(secretDelete).toBeGreaterThan(serviceDelete);
      expect(unrelatedSecretDelete).toBe(-1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not create a Home Manager patch job without the deployed Hermes image", async () => {
    const seenRequests: {
      readonly url: string;
      readonly method: string;
    }[] = [];
    const originalFetch = globalThis.fetch;
    const service = {
      name: "projects/project/locations/us-central1/services/hermes-demo",
      labels: {
        "hermes-managed-scope": "gcp",
        "hermes-managed-deployment": "hermes-demo",
      },
      template: {
        containers: [
          {
            name: "sidecar",
            image: "example/sidecar:1",
          },
        ],
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seenRequests.push({ url, method });
      return new Response(JSON.stringify(service), { status: 200 });
    };

    try {
      const result = await Effect.runPromise(
        Effect.either(
          updateGcpHomeManager(auth, {
            identity: deployment,
            user: "user",
            patch: {
              section: "model",
              block: 'programs.hermes-agent.settings.model.default = "gemini";',
            },
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("deployed Hermes container image");
      }
      expect(
        seenRequests.some(
          (request) =>
            request.url.includes("/jobs/") || request.method === "POST",
        ),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GCP operation polling", () => {
  test("emits Cloud Run operation identity while waiting", async () => {
    const operationName =
      "projects/project/locations/us-central1/operations/operation-1";
    const events: CloudEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ name: operationName, done: true }), {
        status: 200,
      });

    try {
      await Effect.runPromise(
        Effect.provideService(
          waitForCloudRunMutation(auth, "gcp.run.services.apply", {
            name: operationName,
          }),
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
      "Waiting for Cloud Run operation",
      "Cloud Run operation completed",
    ]);
    expect(events.map((event) => event.resource)).toEqual([
      operationName,
      operationName,
    ]);
  });
});
