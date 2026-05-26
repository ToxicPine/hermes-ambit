import { Effect } from "effect";

import {
  ResourceConflict,
  hermesName,
  ownershipMetadata,
  type CloudError,
  type DeploymentDriver,
  type DeploymentIdentity,
} from "@cardelli/shared";

import type { ContainerApp } from "./generated/container-apps/model/containerApp";
import type { AzureAuthContext } from "./client.js";
import {
  azureContainerAppName,
  createOrUpdateContainerApp,
  deleteContainerApp,
  desiredContainerApp,
  findContainerApp,
  startContainerApp,
  stopContainerApp,
  type AzureContainerAppRef,
  type AzureFileState,
} from "./container-apps.js";

export type AzureDeployment = DeploymentIdentity & {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly location: string;
  readonly environmentId: string;
  readonly state: AzureFileState;
};

export type AzureBoundary = {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly location: string;
};

export type AzurePlan = {
  readonly boundary: AzureBoundary;
  readonly containerAppRef: AzureContainerAppRef;
  readonly containerApp: ContainerApp;
  readonly existingContainerApp?: ContainerApp;
};

export type AzureStatus = {
  readonly containerApp?: ContainerApp;
};

export type AzureOperations = DeploymentDriver<
  AzureDeployment,
  AzurePlan,
  AzureStatus
>;

export const azureBaseName = hermesName;

export const azureTags = (identity: AzureDeployment) =>
  ownershipMetadata("azure", identity);

export const azureContainerAppRef = (
  identity: AzureDeployment,
): AzureContainerAppRef => ({
  subscriptionId: identity.subscriptionId,
  resourceGroupName: identity.resourceGroupName,
  containerAppName: azureContainerAppName(identity),
});

const statusFromContainerApp = (
  containerApp: ContainerApp | undefined,
): AzureStatus => (containerApp ? { containerApp } : {});

const assertOwnedContainerApp = (
  expected: AzureDeployment,
  containerApp: ContainerApp | undefined,
): Effect.Effect<void, ResourceConflict> => {
  if (!containerApp) {
    return Effect.void;
  }

  const expectedTags = azureTags(expected);
  for (const [key, value] of Object.entries(expectedTags)) {
    if (containerApp.tags?.[key] !== value) {
      return Effect.fail(
        new ResourceConflict({
          resource:
            containerApp.id ?? azureContainerAppRef(expected).containerAppName,
          message: "Container App name is already used by another deployment",
        }),
      );
    }
  }

  return Effect.void;
};

export const makeAzureDriver = (auth: AzureAuthContext): AzureOperations => {
  const plan = (identity: AzureDeployment): Effect.Effect<AzurePlan, CloudError> =>
    Effect.gen(function* () {
      const containerAppRef = azureContainerAppRef(identity);
      const existingContainerApp = yield* findContainerApp(auth, containerAppRef);
      yield* assertOwnedContainerApp(identity, existingContainerApp);
      const base = {
        boundary: {
          subscriptionId: identity.subscriptionId,
          resourceGroupName: identity.resourceGroupName,
          location: identity.location,
        },
        containerAppRef,
        containerApp: desiredContainerApp({
          identity,
          location: identity.location,
          environmentId: identity.environmentId,
          state: identity.state,
        }),
      };

      return existingContainerApp ? { ...base, existingContainerApp } : base;
    });

  const status = (identity: AzureDeployment) =>
    Effect.gen(function* () {
      const containerApp = yield* findContainerApp(
        auth,
        azureContainerAppRef(identity),
      );
      yield* assertOwnedContainerApp(identity, containerApp);
      return statusFromContainerApp(containerApp);
    });

  const apply = (planned: AzurePlan) =>
    Effect.gen(function* () {
      const result = yield* createOrUpdateContainerApp(
        auth,
        planned.containerAppRef,
        planned.containerApp,
      );
      return statusFromContainerApp(result.data);
    });

  const restart = (identity: AzureDeployment) =>
    Effect.gen(function* () {
      const ref = azureContainerAppRef(identity);
      const existing = yield* findContainerApp(auth, ref);
      yield* assertOwnedContainerApp(identity, existing);
      if (!existing) {
        return statusFromContainerApp(undefined);
      }

      yield* stopContainerApp(auth, ref);
      yield* startContainerApp(auth, ref);
      const containerApp = yield* findContainerApp(auth, ref);
      return statusFromContainerApp(containerApp);
    });

  const destroy = (identity: AzureDeployment) =>
    Effect.gen(function* () {
      const ref = azureContainerAppRef(identity);
      const existing = yield* findContainerApp(auth, ref);
      yield* assertOwnedContainerApp(identity, existing);
      if (!existing) {
        return statusFromContainerApp(undefined);
      }

      yield* deleteContainerApp(auth, ref);
      return statusFromContainerApp(undefined);
    });

  return {
    plan,
    apply,
    status,
    restart,
    destroy,
  };
};
