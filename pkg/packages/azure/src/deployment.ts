import { Effect } from "effect";

import {
  HERMES_CONTAINER_NAME,
  OWNERSHIP_SCOPE_KEY,
  OperationFailed,
  ResourceConflict,
  hermesName,
  isUniversalHermesImageConfigured,
  ownershipMetadata,
  validateHermesDeploymentIdentity,
  type CloudError,
  type DeploymentDriver,
  type DeploymentIdentity,
} from "@cardelli/shared";

import type { ContainerApp } from "./generated/container-apps/model/containerApp";
import {
  waitAzureLongRunningOperation,
  type AzureAuthContext,
} from "./client.js";
import { AZURE_OWNERSHIP_SCOPE } from "./constants.js";
import type {
  AzureBoundary,
  AzureContainerAppRef,
  AzureDiscoveredDeployment,
  AzureDeployment,
  AzureDeploymentRef,
  AzureFileState,
  AzureResourceGroupRef,
  AzureStatus,
} from "./deployment-types.js";
import {
  azureContainerAppName,
  containerAppMatchesInput,
  createOrUpdateContainerApp,
  deleteContainerApp,
  desiredContainerApp,
  findContainerApp,
  listAllContainerAppsByResourceGroup,
  mergeContainerAppInput,
  startContainerApp,
  stopContainerApp,
} from "./container-apps.js";
import type { ContainerAppsListByResourceGroupParams } from "./generated/container-apps/model/containerAppsListByResourceGroupParams";
import {
  azureManagedEnvironmentStorageRefFromDeployment,
  requireManagedEnvironmentStorage,
} from "./environment-storage.js";

export type {
  AzureBoundary,
  AzureContainerAppRef,
  AzureDiscoveredDeployment,
  AzureDeployment,
  AzureDeploymentRef,
  AzureFileState,
  AzureResourceGroupRef,
  AzureStatus,
} from "./deployment-types.js";

type AzurePlanBase = {
  readonly boundary: AzureBoundary;
  readonly containerAppRef: AzureContainerAppRef;
  readonly state: AzureFileState;
};

type AzureCreatePlan = AzurePlanBase & {
  readonly action: "create";
  readonly containerApp: ContainerApp;
};

type AzureReadyPlan = AzurePlanBase & {
  readonly action: "ready";
  readonly existingContainerApp: ContainerApp;
};

type AzureUpdatePlan = AzurePlanBase & {
  readonly action: "update";
  readonly containerApp: ContainerApp;
  readonly existingContainerApp: ContainerApp;
};

export type AzurePlan = AzureCreatePlan | AzureReadyPlan | AzureUpdatePlan;

type AzureOperations = DeploymentDriver<
  AzureDeployment,
  AzurePlan,
  AzureStatus,
  AzureDeploymentRef
>;

const azureTags = (identity: DeploymentIdentity) =>
  ownershipMetadata(AZURE_OWNERSHIP_SCOPE, identity);

export const azureContainerAppRef = (
  identity: AzureDeploymentRef,
): AzureContainerAppRef => ({
  subscriptionId: identity.subscriptionId,
  resourceGroupName: identity.resourceGroupName,
  containerAppName: azureContainerAppName(identity),
});

const requireUniversalImage = (): Effect.Effect<void, OperationFailed> =>
  isUniversalHermesImageConfigured()
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation: "azure.deployment.image",
          message:
            "UNIVERSAL_HERMES_IMAGE must be a published Hermes Ambit runtime image before deploy can create or update Container Apps.",
        }),
      );

const statusFromContainerApp = (
  containerApp: ContainerApp | undefined,
): AzureStatus => {
  if (!containerApp) {
    return { deployed: false };
  }

  const image = containerApp.properties?.template?.containers?.find(
    (container) => container.name === HERMES_CONTAINER_NAME,
  )?.image;
  const endpoint = containerApp.properties?.configuration?.ingress?.fqdn;
  return {
    deployed: true,
    ...(endpoint ? { endpoint } : {}),
    ...(image ? { image } : {}),
    ...(containerApp.properties?.latestReadyRevisionName
      ? {
          latestReadyRevision: containerApp.properties.latestReadyRevisionName,
        }
      : {}),
    ...(containerApp.properties?.latestRevisionName
      ? { latestRevision: containerApp.properties.latestRevisionName }
      : {}),
    ...(containerApp.properties?.runningStatus
      ? { runningStatus: containerApp.properties.runningStatus }
      : {}),
    ...(containerApp.properties?.provisioningState
      ? { provisioningState: containerApp.properties.provisioningState }
      : {}),
  };
};

const discoveredStatusFromContainerApp = (
  containerApp: ContainerApp,
): AzureDiscoveredDeployment => {
  const { deployed: _deployed, ...status } =
    statusFromContainerApp(containerApp);
  return {
    ...status,
    ...(containerApp.name ? { resourceName: containerApp.name } : {}),
  };
};

const isAzureOwnedContainerApp = (containerApp: ContainerApp): boolean =>
  containerApp.tags?.[OWNERSHIP_SCOPE_KEY] === AZURE_OWNERSHIP_SCOPE;

const isAzureDeploymentContainerApp = (
  identity: DeploymentIdentity,
  containerApp: ContainerApp,
): boolean => {
  const expectedTags = azureTags(identity);
  return Object.entries(expectedTags).every(
    ([key, value]) => containerApp.tags?.[key] === value,
  );
};

const assertOwnedContainerApp = (
  expected: AzureDeploymentRef,
  containerApp: ContainerApp | undefined,
): Effect.Effect<void, ResourceConflict> => {
  if (!containerApp) {
    return Effect.void;
  }

  if (!isAzureDeploymentContainerApp(expected, containerApp)) {
    return Effect.fail(
      new ResourceConflict({
        resource:
          containerApp.id ?? azureContainerAppRef(expected).containerAppName,
        message: "Container App name is already used by another deployment",
      }),
    );
  }

  return Effect.void;
};

const listAzureDeploymentContainerApps = (
  auth: AzureAuthContext,
  boundary: AzureResourceGroupRef,
  params?: ContainerAppsListByResourceGroupParams,
): Effect.Effect<readonly ContainerApp[], CloudError> =>
  Effect.map(
    listAllContainerAppsByResourceGroup(auth, boundary, params),
    (apps) => apps.filter(isAzureOwnedContainerApp),
  );

export const listAzureDeploymentStatuses = (
  auth: AzureAuthContext,
  boundary: AzureResourceGroupRef,
  params?: ContainerAppsListByResourceGroupParams,
): Effect.Effect<readonly AzureDiscoveredDeployment[], CloudError> =>
  Effect.map(listAzureDeploymentContainerApps(auth, boundary, params), (apps) =>
    apps.map(discoveredStatusFromContainerApp),
  );

export const makeAzureDriver = (auth: AzureAuthContext): AzureOperations => {
  const plan = (
    identity: AzureDeployment,
  ): Effect.Effect<AzurePlan, CloudError> =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity(
        "azure.deployment.plan",
        identity,
      );
      const storageRef =
        yield* azureManagedEnvironmentStorageRefFromDeployment(identity);
      yield* requireUniversalImage();
      yield* requireManagedEnvironmentStorage(auth, storageRef);
      const containerAppRef = azureContainerAppRef(identity);
      const existingContainerApp = yield* findContainerApp(
        auth,
        containerAppRef,
      );
      yield* assertOwnedContainerApp(identity, existingContainerApp);
      const desiredApp = desiredContainerApp({
        identity,
        location: identity.location,
        environmentId: identity.environmentId,
        state: identity.state,
      });
      const base = {
        boundary: {
          subscriptionId: identity.subscriptionId,
          resourceGroupName: identity.resourceGroupName,
          location: identity.location,
        },
        containerAppRef,
        state: identity.state,
      };

      if (!existingContainerApp) {
        return { ...base, action: "create", containerApp: desiredApp };
      }

      const containerApp = mergeContainerAppInput(
        desiredApp,
        existingContainerApp,
      );
      return containerAppMatchesInput(existingContainerApp, desiredApp)
        ? { ...base, action: "ready", existingContainerApp }
        : { ...base, action: "update", containerApp, existingContainerApp };
    });

  const status = (identity: AzureDeploymentRef) =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity(
        "azure.deployment.status",
        identity,
      );
      const containerApp = yield* findContainerApp(
        auth,
        azureContainerAppRef(identity),
      );
      yield* assertOwnedContainerApp(identity, containerApp);
      return statusFromContainerApp(containerApp);
    });

  const apply = (planned: AzurePlan) =>
    Effect.gen(function* () {
      if (planned.action === "ready") {
        return statusFromContainerApp(planned.existingContainerApp);
      }

      const result = yield* createOrUpdateContainerApp(
        auth,
        planned.containerAppRef,
        planned.containerApp,
      );
      yield* waitAzureLongRunningOperation(
        auth,
        "azure.containerApps.createOrUpdate",
        result,
      );
      const containerApp = yield* findContainerApp(
        auth,
        planned.containerAppRef,
      );
      return statusFromContainerApp(containerApp ?? result.data);
    });

  const restart = (identity: AzureDeploymentRef) =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity(
        "azure.deployment.restart",
        identity,
      );
      const ref = azureContainerAppRef(identity);
      const existing = yield* findContainerApp(auth, ref);
      yield* assertOwnedContainerApp(identity, existing);
      if (!existing) {
        return yield* Effect.fail(
          new OperationFailed({
            operation: "azure.containerApps.restart",
            message:
              "Container App must be deployed before it can be restarted.",
          }),
        );
      }

      const stopped = yield* stopContainerApp(auth, ref);
      yield* waitAzureLongRunningOperation(
        auth,
        "azure.containerApps.stop",
        stopped,
      );
      const started = yield* startContainerApp(auth, ref);
      yield* waitAzureLongRunningOperation(
        auth,
        "azure.containerApps.start",
        started,
      );
      const containerApp = yield* findContainerApp(auth, ref);
      return statusFromContainerApp(containerApp);
    });

  const destroy = (identity: AzureDeploymentRef) =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity(
        "azure.deployment.destroy",
        identity,
      );
      const ref = azureContainerAppRef(identity);
      const existing = yield* findContainerApp(auth, ref);
      yield* assertOwnedContainerApp(identity, existing);
      if (!existing) {
        return statusFromContainerApp(undefined);
      }

      const deleted = yield* deleteContainerApp(auth, ref);
      yield* waitAzureLongRunningOperation(
        auth,
        "azure.containerApps.delete",
        deleted,
      );
      const containerApp = yield* findContainerApp(auth, ref);
      return statusFromContainerApp(containerApp);
    });

  return {
    plan,
    apply,
    status,
    restart,
    destroy,
  };
};
