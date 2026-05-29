import { defineConfig } from "orval";

const splitMode = "split";
const fetchClient = "fetch";
const zodClient = "zod";

const fetchOutput = (target: string, schemas: string, baseUrl: string) => ({
  target,
  schemas,
  baseUrl,
  client: fetchClient,
  mode: splitMode,
  clean: true,
  override: {
    fetch: {
      includeHttpResponseReturnType: true,
    },
  },
});

const zodOutput = (target: string) => ({
  target,
  client: zodClient,
  mode: splitMode,
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
});

const azureContainerAppsInput = {
  target:
    "./openapi/azure/specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2025-07-01/ContainerApps.json",
  override: {
    transformer: "./orval.transformer.ts",
  },
};

const azureManagedEnvironmentStoragesInput = {
  target:
    "./openapi/azure/specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2025-07-01/ManagedEnvironmentsStorages.json",
  override: {
    transformer: "./orval.transformer.ts",
  },
};

const gcpRunInput = {
  target: "./openapi/gcp/run/v2/openapi.json",
};

const gcpRunJobsInput = {
  target: "./openapi/gcp/run/v2/jobs.openapi.json",
};

const gcpSecretManagerInput = {
  target: "./openapi/gcp/secretmanager/v1/openapi.json",
};

const gcpAiplatformInput = {
  target: "./openapi/gcp/aiplatform/v1beta1/openapi.json",
};

const azureOpenAICompatibleInput = {
  target: "./openapi/azure/openai/2024-10-21/models.json",
};

export default defineConfig({
  azureContainerApps: {
    input: azureContainerAppsInput,
    output: fetchOutput(
      "./packages/azure/src/generated/container-apps/client.ts",
      "./packages/azure/src/generated/container-apps/model",
      "https://management.azure.com",
    ),
  },
  azureContainerAppsZod: {
    input: azureContainerAppsInput,
    output: zodOutput("./packages/azure/src/generated/container-apps/client"),
  },
  azureManagedEnvironmentStorages: {
    input: azureManagedEnvironmentStoragesInput,
    output: fetchOutput(
      "./packages/azure/src/generated/managed-environment-storages/client.ts",
      "./packages/azure/src/generated/managed-environment-storages/model",
      "https://management.azure.com",
    ),
  },
  azureManagedEnvironmentStoragesZod: {
    input: azureManagedEnvironmentStoragesInput,
    output: zodOutput(
      "./packages/azure/src/generated/managed-environment-storages/client",
    ),
  },
  gcpRun: {
    input: gcpRunInput,
    output: fetchOutput(
      "./packages/gcp/src/generated/run/client.ts",
      "./packages/gcp/src/generated/run/model",
      "https://run.googleapis.com",
    ),
  },
  gcpRunZod: {
    input: gcpRunInput,
    output: zodOutput("./packages/gcp/src/generated/run/client"),
  },
  gcpRunJobs: {
    input: gcpRunJobsInput,
    output: fetchOutput(
      "./packages/gcp/src/generated/run-jobs/client.ts",
      "./packages/gcp/src/generated/run-jobs/model",
      "https://run.googleapis.com",
    ),
  },
  gcpRunJobsZod: {
    input: gcpRunJobsInput,
    output: zodOutput("./packages/gcp/src/generated/run-jobs/client"),
  },
  gcpSecretManager: {
    input: gcpSecretManagerInput,
    output: fetchOutput(
      "./packages/gcp/src/generated/secret-manager/client.ts",
      "./packages/gcp/src/generated/secret-manager/model",
      "https://secretmanager.googleapis.com",
    ),
  },
  gcpSecretManagerZod: {
    input: gcpSecretManagerInput,
    output: zodOutput("./packages/gcp/src/generated/secret-manager/client"),
  },
  gcpAiplatform: {
    input: gcpAiplatformInput,
    output: fetchOutput(
      "./packages/gcp/src/generated/aiplatform/client.ts",
      "./packages/gcp/src/generated/aiplatform/model",
      "https://aiplatform.googleapis.com",
    ),
  },
  gcpAiplatformZod: {
    input: gcpAiplatformInput,
    output: zodOutput("./packages/gcp/src/generated/aiplatform/client"),
  },
  azureOpenAICompatible: {
    input: azureOpenAICompatibleInput,
    output: fetchOutput(
      "./packages/azure/src/generated/openai/client.ts",
      "./packages/azure/src/generated/openai/model",
      "",
    ),
  },
  azureOpenAICompatibleZod: {
    input: azureOpenAICompatibleInput,
    output: zodOutput("./packages/azure/src/generated/openai/client"),
  },
});
