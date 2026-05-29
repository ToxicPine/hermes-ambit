import {
  deleteAzureRuntimeSecret,
  listAzureRuntimeSecrets,
  listAzureFoundryOpenAICompatibleModels,
  makeAzureDeployer,
  putAzureRuntimeSecret,
  purgeAzureDeploymentState,
  readAzureHomeManagerConfig,
  updateAzureHomeManager,
  type AzureAuthContext,
  type AzureDeployPreview,
  type AzureDiscoveredDeployment,
  type AzureResourceGroupRef,
  type AzureDeployment,
  type AzureDeploymentRef,
  type AzureFoundryOpenAICompatibleAuthContext,
  type AzureFoundryOpenAICompatibleModels,
  type AzureStatus,
} from "@cardelli/azure";
import type { CloudError, HomeManagerPatch } from "@cardelli/shared";
import { Effect } from "effect";

import type {
  AzureStatusSummary,
  ProviderDeployPreviewSummary,
  ProviderDiscoverySummary,
  SupportedModelSummary,
} from "./provider-summary.js";
import type { ProviderOperationResult } from "./provider-operation.js";
import { mapProviderOperationResult } from "./provider-operation.js";

export const summarizeAzureDeployPreview = (
  preview: AzureDeployPreview,
): ProviderDeployPreviewSummary => ({
  boundary: {
    subscriptionId: preview.boundary.subscriptionId,
    resourceGroupName: preview.boundary.resourceGroupName,
    location: preview.boundary.location,
  },
  state: {
    kind: "azure-files",
    storageName: preview.state.storageName,
    dataSubPath: preview.state.dataSubPath,
    nixSubPath: preview.state.nixSubPath,
  },
  resources: [
    {
      action: preview.action === "ready" ? "reuse" : preview.action,
      resourceKind: "container-app",
      resourceName: preview.containerAppName,
    },
    {
      action: "reuse",
      resourceKind: "managed-environment-storage",
      resourceName: preview.state.storageName,
    },
  ],
});

export const summarizeAzureStatus = (
  status: AzureStatus,
): AzureStatusSummary => {
  return {
    deployed: status.deployed,
    ...(status.endpoint
      ? { endpoint: status.endpoint }
      : {}),
    ...(status.image ? { image: status.image } : {}),
    ...(status.latestReadyRevision
      ? {
          latestReadyRevision: status.latestReadyRevision,
        }
      : {}),
    ...(status.latestRevision
      ? { latestRevision: status.latestRevision }
      : {}),
    ...(status.runningStatus
      ? { runningStatus: status.runningStatus }
      : {}),
    ...(status.provisioningState
      ? { provisioningState: status.provisioningState }
      : {}),
  };
};

const summarizeAzureDiscoveryDeployment = (
  status: AzureDiscoveredDeployment,
): ProviderDiscoverySummary["deployments"][number] => {
  const { resourceName, ...summary } = status;
  return {
    resourceKind: "container-app",
    ...summary,
    ...(resourceName ? { resourceName } : {}),
  };
};

export const summarizeAzureFoundryModels = (
  models: AzureFoundryOpenAICompatibleModels,
): readonly SupportedModelSummary[] =>
  models.map((model) => ({
    id: model.id,
    route: "azure-foundry/openai-compatible",
    runtimeTarget: "deployment-name",
  }));

export const makeAzureApp = (auth: AzureAuthContext) => {
  const deployment = makeAzureDeployer(auth);

  return {
    previewDeploy: (
      input: AzureDeployment,
    ): Effect.Effect<AzureDeployPreview, CloudError> =>
      deployment.previewDeploy(input),
    deploy: (input: AzureDeployment): Effect.Effect<AzureStatus, CloudError> =>
      deployment.deploy(input),
    status: (input: AzureDeploymentRef): Effect.Effect<AzureStatus, CloudError> =>
      deployment.status(input),
    discover: (
      boundary: AzureResourceGroupRef,
    ): Effect.Effect<
      ProviderOperationResult<ProviderDiscoverySummary>,
      CloudError
    > =>
      mapProviderOperationResult(
        deployment.discover(boundary),
        (raw) => ({
          boundary,
          deployments: raw.map(summarizeAzureDiscoveryDeployment),
        }),
      ),
    validateSetup: (
      input: AzureDeployment,
    ): Effect.Effect<void, CloudError> =>
      deployment.validateSetup(input),
    restart: (input: AzureDeploymentRef): Effect.Effect<AzureStatus, CloudError> =>
      deployment.restart(input),
    destroy: (input: AzureDeploymentRef): Effect.Effect<AzureStatus, CloudError> =>
      deployment.destroy(input),
    destroyWithStatePurge: (
      input: AzureDeployment,
      filesAuth: AzureAuthContext,
    ): Effect.Effect<AzureStatus, CloudError> =>
      purgeAzureDeploymentState(auth, filesAuth, input),
    listRuntimeSecrets: (
      input: AzureDeploymentRef,
    ): Effect.Effect<readonly string[], CloudError> =>
      listAzureRuntimeSecrets(auth, input),
    putRuntimeSecret: (
      input: AzureDeploymentRef,
      runtimeName: string,
      value: string,
    ): Effect.Effect<AzureStatus, CloudError> =>
      putAzureRuntimeSecret(auth, { ...input, runtimeName, value }),
    deleteRuntimeSecret: (
      input: AzureDeploymentRef,
      runtimeName: string,
    ): Effect.Effect<AzureStatus, CloudError> =>
      deleteAzureRuntimeSecret(auth, { ...input, runtimeName }),
  };
};

export const makeAzureHomeManagerApp = (
  armAuth: AzureAuthContext,
  filesAuth: AzureAuthContext,
) => ({
  readConfig: (
    input: AzureDeployment,
    user: string,
  ): Effect.Effect<string | undefined, CloudError> =>
    readAzureHomeManagerConfig(armAuth, filesAuth, input, user),
  applyPatch: (
    input: AzureDeployment,
    user: string,
    patch: HomeManagerPatch,
  ): Effect.Effect<AzureStatus, CloudError> =>
    updateAzureHomeManager(armAuth, filesAuth, {
      identity: input,
      user,
      patch,
    }),
});

export const makeAzureFoundryModelApp = (
  auth: AzureFoundryOpenAICompatibleAuthContext,
) => ({
  listSupportedModels: (
    endpoint: string,
  ): Effect.Effect<
    ProviderOperationResult<readonly SupportedModelSummary[]>,
    CloudError
  > =>
    mapProviderOperationResult(
      listAzureFoundryOpenAICompatibleModels(auth, endpoint),
      summarizeAzureFoundryModels,
    ),
});
