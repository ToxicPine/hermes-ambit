import { defineConfig } from "orval";

const azureContainerAppsInput = {
  target:
    "./openapi/azure/specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2025-07-01/ContainerApps.json",
  override: {
    transformer: "./orval.transformer.ts",
  },
} as const;

const gcpRunInput = {
  target: "./openapi/gcp/run/v2/openapi.json",
} as const;

const gcpSecretManagerInput = {
  target: "./openapi/gcp/secretmanager/v1/openapi.json",
} as const;

export default defineConfig({
  azureContainerApps: {
    input: {
      ...azureContainerAppsInput,
    },
    output: {
      target: "./packages/azure/src/generated/container-apps/client.ts",
      schemas: "./packages/azure/src/generated/container-apps/model",
      baseUrl: "https://management.azure.com",
      client: "fetch",
      mode: "split",
      clean: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: true,
        },
      },
    },
  },
  azureContainerAppsZod: {
    input: {
      ...azureContainerAppsInput,
    },
    output: {
      target: "./packages/azure/src/generated/container-apps/client",
      client: "zod",
      mode: "split",
      fileExtension: ".zod.ts",
      override: {
        zod: {
          generate: {
            body: true,
            header: true,
            param: true,
            query: true,
            response: true,
          },
          generateEachHttpStatus: true,
        },
      },
    },
  },
  gcpRun: {
    input: {
      ...gcpRunInput,
    },
    output: {
      target: "./packages/gcp/src/generated/run/client.ts",
      schemas: "./packages/gcp/src/generated/run/model",
      baseUrl: "https://run.googleapis.com",
      client: "fetch",
      mode: "split",
      clean: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: true,
        },
      },
    },
  },
  gcpRunZod: {
    input: {
      ...gcpRunInput,
    },
    output: {
      target: "./packages/gcp/src/generated/run/client",
      client: "zod",
      mode: "split",
      fileExtension: ".zod.ts",
      override: {
        zod: {
          generate: {
            body: true,
            header: true,
            param: true,
            query: true,
            response: true,
          },
          generateEachHttpStatus: true,
        },
      },
    },
  },
  gcpSecretManager: {
    input: {
      ...gcpSecretManagerInput,
    },
    output: {
      target: "./packages/gcp/src/generated/secret-manager/client.ts",
      schemas: "./packages/gcp/src/generated/secret-manager/model",
      baseUrl: "https://secretmanager.googleapis.com",
      client: "fetch",
      mode: "split",
      clean: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: true,
        },
      },
    },
  },
  gcpSecretManagerZod: {
    input: {
      ...gcpSecretManagerInput,
    },
    output: {
      target: "./packages/gcp/src/generated/secret-manager/client",
      client: "zod",
      mode: "split",
      fileExtension: ".zod.ts",
      override: {
        zod: {
          generate: {
            body: true,
            header: true,
            param: true,
            query: true,
            response: true,
          },
          generateEachHttpStatus: true,
        },
      },
    },
  },
});
