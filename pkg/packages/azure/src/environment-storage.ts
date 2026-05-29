import { Effect } from "effect";

import {
  expectHttpStatus,
  failHttpResponse,
  OperationFailed,
  RemediationRequired,
  type CloudError,
} from "@cardelli/shared";

import {
  managedEnvironmentsStoragesGet,
  type managedEnvironmentsStoragesGetResponseSuccess,
} from "./generated/managed-environment-storages/client";
import {
  managedEnvironmentsStoragesGet200Response,
} from "./generated/managed-environment-storages/client/containerAppsAPIClient.zod";
import type { ManagedEnvironmentsStoragesGetParams } from "./generated/managed-environment-storages/model/managedEnvironmentsStoragesGetParams";
import { AZURE_CONTAINER_APPS_API_VERSION } from "./constants.js";
import {
  sendAzure,
  validateAzureResponseData,
  type AzureAuthContext,
} from "./client.js";
import type {
  AzureDeployment,
  AzureResourceGroupRef,
} from "./deployment-types.js";

type AzureManagedEnvironmentRef = AzureResourceGroupRef & {
  readonly environmentName: string;
};

export type AzureManagedEnvironmentStorageRef = AzureManagedEnvironmentRef & {
  readonly storageName: string;
};

const apiVersionParams = {
  "api-version": AZURE_CONTAINER_APPS_API_VERSION,
};

const segmentAfter = (
  segments: readonly string[],
  name: string,
): string | undefined => {
  const index = segments.findIndex(
    (segment) => segment.toLowerCase() === name.toLowerCase(),
  );
  return index >= 0 ? segments[index + 1] : undefined;
};

const azureManagedEnvironmentRefFromId = (
  environmentId: string,
): AzureManagedEnvironmentRef | undefined => {
  const segments = environmentId
    .split("/")
    .filter((segment) => segment.length > 0);
  const subscriptionId = segmentAfter(segments, "subscriptions");
  const resourceGroupName = segmentAfter(segments, "resourceGroups");
  const provider = segmentAfter(segments, "providers");
  const environmentName = segmentAfter(segments, "managedEnvironments");

  return subscriptionId &&
    resourceGroupName &&
    provider?.toLowerCase() === "microsoft.app" &&
    environmentName
    ? {
        subscriptionId,
        resourceGroupName,
        environmentName,
      }
    : undefined;
};

const invalidAzureManagedEnvironmentId = (
  environmentId: string,
): OperationFailed =>
  new OperationFailed({
    operation: "azure.managedEnvironments.id",
    message:
      "Azure deployment environmentId must be a Microsoft.App/managedEnvironments resource ID.",
    cause: { environmentId },
  });

const sameAzureBoundarySegment = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const environmentBoundaryMatchesDeployment = (
  environmentRef: AzureManagedEnvironmentRef,
  deployment: AzureDeployment,
): boolean =>
  sameAzureBoundarySegment(
    environmentRef.subscriptionId,
    deployment.subscriptionId,
  ) &&
  sameAzureBoundarySegment(
    environmentRef.resourceGroupName,
    deployment.resourceGroupName,
  );

const mismatchedAzureManagedEnvironmentBoundary = (
  deployment: AzureDeployment,
  environmentRef: AzureManagedEnvironmentRef,
): OperationFailed =>
  new OperationFailed({
    operation: "azure.managedEnvironments.boundary",
    message:
      "Azure deployment environmentId must be in the selected subscription and resource group.",
    cause: {
      environmentId: deployment.environmentId,
      selectedSubscriptionId: deployment.subscriptionId,
      selectedResourceGroupName: deployment.resourceGroupName,
      environmentSubscriptionId: environmentRef.subscriptionId,
      environmentResourceGroupName: environmentRef.resourceGroupName,
    },
  });

const validateAzureFileState = (
  deployment: AzureDeployment,
): Effect.Effect<void, OperationFailed> =>
  deployment.state.storageName.trim().length > 0 &&
  deployment.state.dataSubPath.trim().length > 0 &&
  deployment.state.nixSubPath.trim().length > 0
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation: "azure.deployment.state",
          message:
            "Azure deployment state requires non-empty environment storage name, data subpath, and Nix subpath.",
        }),
      );

export const azureManagedEnvironmentStorageRefFromDeployment = (
  deployment: AzureDeployment,
): Effect.Effect<AzureManagedEnvironmentStorageRef, OperationFailed> =>
  Effect.gen(function* () {
    yield* validateAzureFileState(deployment);

    const environmentRef = azureManagedEnvironmentRefFromId(
      deployment.environmentId,
    );
    if (!environmentRef) {
      return yield* Effect.fail(
        invalidAzureManagedEnvironmentId(deployment.environmentId),
      );
    }
    if (!environmentBoundaryMatchesDeployment(environmentRef, deployment)) {
      return yield* Effect.fail(
        mismatchedAzureManagedEnvironmentBoundary(deployment, environmentRef),
      );
    }

    return {
      subscriptionId: deployment.subscriptionId,
      resourceGroupName: deployment.resourceGroupName,
      environmentName: environmentRef.environmentName,
      storageName: deployment.state.storageName,
    };
  });

export const getManagedEnvironmentStorage = (
  auth: AzureAuthContext,
  ref: AzureManagedEnvironmentStorageRef,
  params: ManagedEnvironmentsStoragesGetParams = apiVersionParams,
): Effect.Effect<managedEnvironmentsStoragesGetResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.managedEnvironments.storages.get";
    const response = yield* sendAzure(auth, operation, (options) =>
      managedEnvironmentsStoragesGet(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.environmentName,
        ref.storageName,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateAzureResponseData(
      operation,
      success,
      managedEnvironmentsStoragesGet200Response,
    );
  });

const findManagedEnvironmentStorage = (
  auth: AzureAuthContext,
  ref: AzureManagedEnvironmentStorageRef,
  params: ManagedEnvironmentsStoragesGetParams = apiVersionParams,
): Effect.Effect<
  managedEnvironmentsStoragesGetResponseSuccess | undefined,
  CloudError
> =>
  Effect.gen(function* () {
    const operation = "azure.managedEnvironments.storages.find";
    const response = yield* sendAzure(auth, operation, (options) =>
      managedEnvironmentsStoragesGet(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.environmentName,
        ref.storageName,
        params,
        options,
      ),
    );
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      return yield* failHttpResponse(operation, response);
    }
    return yield* validateAzureResponseData(
      operation,
      response,
      managedEnvironmentsStoragesGet200Response,
    );
  });

export const requireManagedEnvironmentStorage = (
  auth: AzureAuthContext,
  ref: AzureManagedEnvironmentStorageRef,
): Effect.Effect<managedEnvironmentsStoragesGetResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const storage = yield* findManagedEnvironmentStorage(auth, ref);
    if (storage) {
      return storage;
    }

    return yield* Effect.fail(
      new RemediationRequired({
        scope: "azure.managedEnvironments.storages.require",
        message:
          "Azure Container Apps environment storage must exist before Hermes can mount durable state.",
        remediation: {
          type: "url",
          label: "Create Container Apps environment storage",
          url: "https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts",
        },
      }),
    );
  });

export const requireAzureDeploymentStateStorage = (
  auth: AzureAuthContext,
  deployment: AzureDeployment,
): Effect.Effect<managedEnvironmentsStoragesGetResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const ref = yield* azureManagedEnvironmentStorageRefFromDeployment(deployment);
    return yield* requireManagedEnvironmentStorage(auth, ref);
  });
