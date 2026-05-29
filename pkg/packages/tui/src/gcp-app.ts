import {
  listGcpRuntimeSecrets,
  listGooglePublisherModels,
  makeGcpDeployer,
  putGcpRuntimeSecret,
  deleteGcpRuntimeSecret,
  updateGcpHomeManager,
  type GcpDeployPreview,
  type GcpDiscoveredDeployment,
  type GcpPublisherModels,
  type GcpAuthContext,
  type GcpDeployment,
  type GcpDeploymentRef,
  type GcpBoundary,
  type GcpStatus,
} from "@cardelli/gcp";
import type { CloudError, HomeManagerModule } from "@cardelli/shared";
import { Effect } from "effect";

import type {
  GcpStatusSummary,
  ProviderDeployPreviewSummary,
  ProviderDiscoverySummary,
  SupportedModelSummary,
} from "./provider-summary.js";
import type { ProviderOperationResult } from "./provider-operation.js";
import { mapProviderOperationResult } from "./provider-operation.js";

type GcpPublisherModel = GcpPublisherModels[number];

export const summarizeGcpDeployPreview = (
  preview: GcpDeployPreview,
): ProviderDeployPreviewSummary => ({
  boundary: {
    projectId: preview.boundary.projectId,
    region: preview.boundary.region,
  },
  state: {
    kind: "nfs",
    server: preview.state.server,
    dataPath: preview.state.dataPath,
    nixPath: preview.state.nixPath,
  },
  resources: [
    {
      action: preview.action === "ready" ? "reuse" : preview.action,
      resourceKind: "cloud-run-service",
      resourceName: preview.serviceName,
    },
    {
      action: "reuse",
      resourceKind: "nfs-state",
      resourceName: `${preview.state.server}:${preview.state.dataPath}, ${preview.state.server}:${preview.state.nixPath}`,
    },
  ],
});

export const summarizeGcpStatus = (status: GcpStatus): GcpStatusSummary => {
  return {
    deployed: status.deployed,
    ...(status.endpoint ? { endpoint: status.endpoint } : {}),
    ...(status.image ? { image: status.image } : {}),
    ...(status.latestReadyRevision
      ? { latestReadyRevision: status.latestReadyRevision }
      : {}),
    ...(status.latestCreatedRevision
      ? { latestCreatedRevision: status.latestCreatedRevision }
      : {}),
    ...(status.reconciling !== undefined
      ? { reconciling: status.reconciling }
      : {}),
  };
};

const summarizeGcpDiscoveryDeployment = (
  status: GcpDiscoveredDeployment,
): ProviderDiscoverySummary["deployments"][number] => {
  const { resourceName, ...summary } = status;
  return {
    resourceKind: "cloud-run-service",
    ...summary,
    ...(resourceName ? { resourceName } : {}),
  };
};

const supportedGcpSharedModelPrefixes = ["gemini-"];

const isSupportedGcpSharedModel = (model: GcpPublisherModel): boolean => {
  const id = model.id;
  return (
    supportedGcpSharedModelPrefixes.some((prefix) => id.startsWith(prefix)) &&
    model.supportsRestApi
  );
};

export const summarizeGcpModels = (
  models: GcpPublisherModels,
): readonly SupportedModelSummary[] =>
  models.filter(isSupportedGcpSharedModel).map((model) => ({
    id: model.id,
    route: "gemini/developer-api",
    runtimeTarget: "model-id",
  }));

export const makeGcpApp = (auth: GcpAuthContext) => {
  const deployment = makeGcpDeployer(auth);

  return {
    previewDeploy: (
      input: GcpDeployment,
    ): Effect.Effect<GcpDeployPreview, CloudError> =>
      deployment.previewDeploy(input),
    deploy: (input: GcpDeployment): Effect.Effect<GcpStatus, CloudError> =>
      deployment.deploy(input),
    status: (input: GcpDeploymentRef): Effect.Effect<GcpStatus, CloudError> =>
      deployment.status(input),
    discover: (
      boundary: GcpBoundary,
    ): Effect.Effect<
      ProviderOperationResult<ProviderDiscoverySummary>,
      CloudError
    > =>
      mapProviderOperationResult(deployment.discover(boundary), (raw) => ({
        boundary,
        deployments: raw.map(summarizeGcpDiscoveryDeployment),
      })),
    validateSetup: (input: GcpDeployment): Effect.Effect<void, CloudError> =>
      deployment.validateSetup(input),
    restart: (input: GcpDeploymentRef): Effect.Effect<GcpStatus, CloudError> =>
      deployment.restart(input),
    destroy: (input: GcpDeploymentRef): Effect.Effect<GcpStatus, CloudError> =>
      deployment.destroy(input),
    listRuntimeSecrets: (input: GcpDeploymentRef) =>
      listGcpRuntimeSecrets(auth, input),
    putRuntimeSecret: (
      input: GcpDeploymentRef,
      runtimeName: string,
      value: string,
    ): Effect.Effect<GcpStatus, CloudError> =>
      putGcpRuntimeSecret(auth, { ...input, runtimeName, value }),
    deleteRuntimeSecret: (
      input: GcpDeploymentRef,
      runtimeName: string,
    ): Effect.Effect<GcpStatus, CloudError> =>
      deleteGcpRuntimeSecret(auth, { ...input, runtimeName }),
    listSupportedModels: (
      region: string,
    ): Effect.Effect<
      ProviderOperationResult<readonly SupportedModelSummary[]>,
      CloudError
    > =>
      mapProviderOperationResult(
        listGooglePublisherModels(auth, region),
        summarizeGcpModels,
      ),
  };
};

export const makeGcpHomeManagerApp = (auth: GcpAuthContext) => ({
  writeModule: (
    deployment: GcpDeployment,
    user: string,
    module: HomeManagerModule,
  ) =>
    updateGcpHomeManager(auth, {
      identity: deployment,
      user,
      module,
    }),
});
