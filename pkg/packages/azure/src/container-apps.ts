import { Effect } from "effect";

import {
  HERMES_CONTAINER_NAME,
  HERMES_DATA_MOUNT_PATH,
  HERMES_DATA_VOLUME_NAME,
  HERMES_GATEWAY_PORT,
  HERMES_NIX_MOUNT_PATH,
  HERMES_NIX_VOLUME_NAME,
  UNIVERSAL_HERMES_IMAGE,
  expectHttpSuccess,
  failHttpResponse,
  hermesName,
  ownershipMetadata,
  type CloudError,
  type DeploymentIdentity,
} from "@cardelli/shared";

import {
  containerAppsCreateOrUpdate,
  containerAppsDelete,
  containerAppsGet,
  containerAppsListSecrets,
  containerAppsStart,
  containerAppsStop,
  containerAppsUpdate,
  type containerAppsCreateOrUpdateResponseSuccess,
  type containerAppsDeleteResponseSuccess,
  type containerAppsGetResponseSuccess,
  type containerAppsListSecretsResponseSuccess,
  type containerAppsStartResponseSuccess,
  type containerAppsStopResponseSuccess,
  type containerAppsUpdateResponseSuccess,
} from "./generated/container-apps/client";
import type { ContainerApp } from "./generated/container-apps/model/containerApp";
import type { ContainerAppsCreateOrUpdateParams } from "./generated/container-apps/model/containerAppsCreateOrUpdateParams";
import type { ContainerAppsDeleteParams } from "./generated/container-apps/model/containerAppsDeleteParams";
import type { ContainerAppsGetParams } from "./generated/container-apps/model/containerAppsGetParams";
import type { ContainerAppsListSecretsParams } from "./generated/container-apps/model/containerAppsListSecretsParams";
import type { ContainerAppsStartParams } from "./generated/container-apps/model/containerAppsStartParams";
import type { ContainerAppsStopParams } from "./generated/container-apps/model/containerAppsStopParams";
import type { ContainerAppsUpdateParams } from "./generated/container-apps/model/containerAppsUpdateParams";
import { sendAzure, type AzureAuthContext } from "./client.js";

export const AZURE_CONTAINER_APPS_API_VERSION = "2025-07-01";

export type AzureContainerAppRef = {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly containerAppName: string;
};

export type AzureFileState = {
  readonly storageName: string;
  readonly dataSubPath: string;
  readonly nixSubPath: string;
};

export type AzureContainerAppSpec = {
  readonly identity: DeploymentIdentity;
  readonly location: string;
  readonly environmentId: string;
  readonly state: AzureFileState;
};

const apiVersionParams = {
  "api-version": AZURE_CONTAINER_APPS_API_VERSION,
};

export const desiredContainerApp = (spec: AzureContainerAppSpec): ContainerApp => ({
  location: spec.location,
  tags: ownershipMetadata("azure", spec.identity),
  properties: {
    environmentId: spec.environmentId,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: {
        external: true,
        targetPort: HERMES_GATEWAY_PORT,
      },
    },
    template: {
      containers: [
        {
          name: HERMES_CONTAINER_NAME,
          image: UNIVERSAL_HERMES_IMAGE,
          volumeMounts: [
            {
              volumeName: HERMES_DATA_VOLUME_NAME,
              mountPath: HERMES_DATA_MOUNT_PATH,
              subPath: spec.state.dataSubPath,
            },
            {
              volumeName: HERMES_NIX_VOLUME_NAME,
              mountPath: HERMES_NIX_MOUNT_PATH,
              subPath: spec.state.nixSubPath,
            },
          ],
        },
      ],
      volumes: [
        {
          name: HERMES_DATA_VOLUME_NAME,
          storageType: "AzureFile",
          storageName: spec.state.storageName,
        },
        {
          name: HERMES_NIX_VOLUME_NAME,
          storageType: "AzureFile",
          storageName: spec.state.storageName,
        },
      ],
    },
  },
});

export const azureContainerAppName = (identity: DeploymentIdentity) =>
  hermesName(identity);

export const getContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsGetParams = apiVersionParams,
): Effect.Effect<containerAppsGetResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.get";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsGet(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const findContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsGetParams = apiVersionParams,
): Effect.Effect<ContainerApp | undefined, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.find";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsGet(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );

    if (response.status === 200) {
      return response.data;
    }
    if (response.status === 404) {
      return undefined;
    }
    return yield* failHttpResponse(operation, response);
  });

export const createOrUpdateContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  app: ContainerApp,
  params: ContainerAppsCreateOrUpdateParams = apiVersionParams,
): Effect.Effect<containerAppsCreateOrUpdateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.createOrUpdate";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsCreateOrUpdate(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        app,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const listContainerAppSecrets = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsListSecretsParams = apiVersionParams,
): Effect.Effect<containerAppsListSecretsResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.listSecrets";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsListSecrets(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const updateContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  app: ContainerApp,
  params: ContainerAppsUpdateParams = apiVersionParams,
): Effect.Effect<containerAppsUpdateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.update";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsUpdate(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        app,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const deleteContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsDeleteParams = apiVersionParams,
): Effect.Effect<containerAppsDeleteResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.delete";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsDelete(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const startContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsStartParams = apiVersionParams,
): Effect.Effect<containerAppsStartResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.start";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsStart(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const stopContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsStopParams = apiVersionParams,
): Effect.Effect<containerAppsStopResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.stop";
    const response = yield* sendAzure(auth, operation, ({ options }) =>
      containerAppsStop(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });
