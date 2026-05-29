import { Effect } from "effect";
import { z } from "zod";

import {
  HERMES_CONTAINER_NAME,
  HERMES_DATA_MOUNT_PATH,
  HERMES_DATA_VOLUME_NAME,
  HERMES_GATEWAY_PORT,
  HERMES_NIX_MOUNT_PATH,
  HERMES_NIX_VOLUME_NAME,
  UNIVERSAL_HERMES_IMAGE,
  OperationFailed,
  expectHttpStatus,
  failHttpResponse,
  hermesName,
  invokeJsonHttp,
  ownershipMetadata,
  type CloudError,
  type DeploymentIdentity,
} from "@cardelli/shared";
import type {
  AzureContainerAppRef,
  AzureFileState,
  AzureResourceGroupRef,
} from "./deployment-types.js";

import {
  containerAppsCreateOrUpdate,
  containerAppsDelete,
  containerAppsGet,
  containerAppsListByResourceGroup,
  containerAppsStart,
  containerAppsStop,
  type containerAppsCreateOrUpdateResponseSuccess,
  type containerAppsDeleteResponseSuccess,
  type containerAppsListByResourceGroupResponseSuccess,
  type containerAppsStartResponseSuccess,
  type containerAppsStopResponseSuccess,
} from "./generated/container-apps/client";
import {
  AZURE_CONTAINER_APPS_API_VERSION,
  AZURE_OWNERSHIP_SCOPE,
} from "./constants.js";
import type { ContainerApp } from "./generated/container-apps/model/containerApp";
import type { ContainerAppCollection } from "./generated/container-apps/model/containerAppCollection";
import type { Container } from "./generated/container-apps/model/CommonDefinitions/container";
import type { EnvironmentVar } from "./generated/container-apps/model/CommonDefinitions/environmentVar";
import type { Volume } from "./generated/container-apps/model/CommonDefinitions/volume";
import type { ContainerAppsCreateOrUpdateParams } from "./generated/container-apps/model/containerAppsCreateOrUpdateParams";
import type { ContainerAppsDeleteParams } from "./generated/container-apps/model/containerAppsDeleteParams";
import type { ContainerAppsGetParams } from "./generated/container-apps/model/containerAppsGetParams";
import type { ContainerAppsListByResourceGroupParams } from "./generated/container-apps/model/containerAppsListByResourceGroupParams";
import type { ContainerAppsStartParams } from "./generated/container-apps/model/containerAppsStartParams";
import type { ContainerAppsStopParams } from "./generated/container-apps/model/containerAppsStopParams";
import type { ManagedServiceIdentity } from "./generated/container-apps/model/common-types-resource-management-v3-managedidentity/managedServiceIdentity";
import type { UserAssignedIdentity } from "./generated/container-apps/model/common-types-resource-management-v3-managedidentity/userAssignedIdentity";
import {
  authorizedAzureRequest,
  sendAzure,
  validateAzureResponseData,
  type AzureAuthContext,
} from "./client.js";
import {
  containerAppsCreateOrUpdate200Response,
  containerAppsCreateOrUpdate201Response,
  containerAppsGet200Response,
  containerAppsListByResourceGroup200Response,
  containerAppsStart200Response,
  containerAppsStop200Response,
} from "./generated/container-apps/client/containerAppsAPIClient.zod";

type AzureContainerAppSpec = {
  readonly identity: DeploymentIdentity;
  readonly location: string;
  readonly environmentId: string;
  readonly state: AzureFileState;
};

export type AzureSecretEnvironmentVariable = {
  readonly name: string;
  readonly secretRef: string;
};

const apiVersionParams = {
  "api-version": AZURE_CONTAINER_APPS_API_VERSION,
};

const azureSecretEnvironmentVariable = (
  variable: AzureSecretEnvironmentVariable,
): EnvironmentVar => ({
  name: variable.name,
  secretRef: variable.secretRef,
});

const sameJsonShape = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const includesMetadata = (
  current: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>> | undefined,
): boolean =>
  Object.entries(expected ?? {}).every(
    ([key, value]) => current?.[key] === value,
  );

const findContainer = (
  containers: readonly Container[] | undefined,
  name: string | undefined,
) => containers?.find((container) => container.name === name);

const projectEnvironment = (
  current: readonly EnvironmentVar[] | undefined,
  expected: readonly EnvironmentVar[] | undefined,
) =>
  expected?.map((variable) =>
    variable.name === undefined
      ? variable
      : current?.find((entry) => entry.name === variable.name),
  );

const projectContainer = (
  container: Container | undefined,
  expected: Container | undefined,
) =>
  container
    ? {
        name: container.name,
        image: container.image,
        volumeMounts: container.volumeMounts?.map((mount) => ({
          volumeName: mount.volumeName,
          mountPath: mount.mountPath,
          subPath: mount.subPath,
        })),
        ...(expected?.env
          ? { env: projectEnvironment(container.env, expected.env) }
          : {}),
      }
    : undefined;

const projectVolumes = (volumes: readonly Volume[] | undefined) =>
  [HERMES_DATA_VOLUME_NAME, HERMES_NIX_VOLUME_NAME].map((name) => {
    const volume = volumes?.find((entry) => entry.name === name);
    return volume
      ? {
          name: volume.name,
          storageType: volume.storageType,
          storageName: volume.storageName,
        }
      : undefined;
  });

const identityHasSystemAssigned = (
  identity: ManagedServiceIdentity | undefined,
): boolean =>
  identity?.type === "SystemAssigned" ||
  identity?.type === "SystemAssigned,UserAssigned";

const identityHasUserAssigned = (
  identity: ManagedServiceIdentity | undefined,
): boolean =>
  identity?.type === "UserAssigned" ||
  identity?.type === "SystemAssigned,UserAssigned";

const userAssignedIdentityIds = (
  identity: ManagedServiceIdentity | undefined,
): readonly string[] =>
  Object.keys(identity?.userAssignedIdentities ?? {}).sort();

const identityTypeSatisfies = (
  current: ManagedServiceIdentity | undefined,
  expected: ManagedServiceIdentity,
): boolean => {
  if (expected.type === "SystemAssigned") {
    return identityHasSystemAssigned(current);
  }
  if (expected.type === "UserAssigned") {
    return identityHasUserAssigned(current);
  }
  if (expected.type === "SystemAssigned,UserAssigned") {
    return (
      identityHasSystemAssigned(current) && identityHasUserAssigned(current)
    );
  }
  return current?.type === expected.type;
};

const identityMatches = (
  current: ManagedServiceIdentity | undefined,
  expected: ManagedServiceIdentity | undefined,
): boolean => {
  if (!expected) return true;
  const currentUserAssignedIds = new Set(userAssignedIdentityIds(current));
  return (
    identityTypeSatisfies(current, expected) &&
    userAssignedIdentityIds(expected).every((id) =>
      currentUserAssignedIds.has(id),
    )
  );
};

const identityType = (
  systemAssigned: boolean,
  userAssigned: boolean,
): ManagedServiceIdentity["type"] =>
  systemAssigned && userAssigned
    ? "SystemAssigned,UserAssigned"
    : systemAssigned
      ? "SystemAssigned"
      : userAssigned
        ? "UserAssigned"
        : "None";

const userAssignedIdentityMap = (
  ids: readonly string[],
): Record<string, UserAssignedIdentity> | undefined => {
  if (ids.length === 0) return undefined;
  const identities: Record<string, UserAssignedIdentity> = {};
  for (const id of ids) {
    identities[id] = {};
  }
  return identities;
};

const mergeContainerAppIdentity = (
  desired: ManagedServiceIdentity | undefined,
  current: ManagedServiceIdentity | undefined,
): ManagedServiceIdentity | undefined => {
  if (!desired) return current;
  const ids = Array.from(
    new Set([
      ...userAssignedIdentityIds(current),
      ...userAssignedIdentityIds(desired),
    ]),
  ).sort();
  const userIdentities = userAssignedIdentityMap(ids);
  return {
    type: identityType(
      identityHasSystemAssigned(desired) || identityHasSystemAssigned(current),
      ids.length > 0 || identityHasUserAssigned(desired),
    ),
    ...(userIdentities ? { userAssignedIdentities: userIdentities } : {}),
  };
};

const mergeContainerAppIdentityField = (
  desired: ManagedServiceIdentity | undefined,
  current: ManagedServiceIdentity | undefined,
): Partial<Pick<ContainerApp, "identity">> => {
  const identity = mergeContainerAppIdentity(desired, current);
  return identity ? { identity } : {};
};

const containerMatches = (
  current: readonly Container[] | undefined,
  expected: Container,
): boolean =>
  sameJsonShape(
    projectContainer(findContainer(current, expected.name), expected),
    projectContainer(expected, expected),
  );

export const containerAppMatchesInput = (
  current: ContainerApp,
  expected: ContainerApp,
): boolean => {
  const expectedProperties = expected.properties;
  const currentProperties = current.properties;
  const expectedConfiguration = expectedProperties?.configuration;
  const currentConfiguration = currentProperties?.configuration;
  const expectedTemplate = expectedProperties?.template;
  const currentTemplate = currentProperties?.template;
  const expectedContainer = expectedTemplate?.containers?.find(
    (container) => container.name === HERMES_CONTAINER_NAME,
  );

  return (
    current.location === expected.location &&
    includesMetadata(current.tags, expected.tags) &&
    identityMatches(current.identity, expected.identity) &&
    currentProperties?.environmentId === expectedProperties?.environmentId &&
    currentConfiguration?.activeRevisionsMode ===
      expectedConfiguration?.activeRevisionsMode &&
    currentConfiguration?.ingress?.external ===
      expectedConfiguration?.ingress?.external &&
    currentConfiguration?.ingress?.targetPort ===
      expectedConfiguration?.ingress?.targetPort &&
    (!expectedContainer ||
      containerMatches(currentTemplate?.containers, expectedContainer)) &&
    sameJsonShape(
      projectVolumes(currentTemplate?.volumes),
      projectVolumes(expectedTemplate?.volumes),
    )
  );
};

const preserveContainerRuntime = (
  desired: Container,
  current: Container | undefined,
): Container => ({
  ...desired,
  ...(desired.env === undefined && current?.env ? { env: current.env } : {}),
});

export const mergeContainerAppInput = (
  desired: ContainerApp,
  current: ContainerApp,
): ContainerApp => {
  const desiredProperties = desired.properties ?? {};
  const currentProperties = current.properties ?? {};
  const desiredConfiguration = desiredProperties.configuration ?? {};
  const currentConfiguration = currentProperties.configuration ?? {};
  const desiredTemplate = desiredProperties.template ?? {};
  const currentTemplate = currentProperties.template ?? {};
  const desiredContainers = desiredTemplate.containers;

  return {
    ...desired,
    tags: {
      ...(current.tags ?? {}),
      ...(desired.tags ?? {}),
    },
    ...mergeContainerAppIdentityField(desired.identity, current.identity),
    properties: {
      ...desiredProperties,
      configuration: {
        ...desiredConfiguration,
        ...(desiredConfiguration.secrets === undefined &&
        currentConfiguration.secrets
          ? { secrets: currentConfiguration.secrets }
          : {}),
      },
      template: {
        ...desiredTemplate,
        ...(desiredContainers
          ? {
              containers: desiredContainers.map((container) =>
                preserveContainerRuntime(
                  container,
                  findContainer(currentTemplate.containers, container.name),
                ),
              ),
            }
          : {}),
      },
    },
  };
};

const mergeAzureEnvironment = (
  current: readonly EnvironmentVar[] | undefined,
  incoming: readonly EnvironmentVar[],
): EnvironmentVar[] => {
  const incomingNames = new Set(
    incoming.flatMap((variable) =>
      variable.name === undefined ? [] : [variable.name],
    ),
  );
  return [
    ...(current ?? []).filter(
      (variable) =>
        variable.name === undefined || !incomingNames.has(variable.name),
    ),
    ...incoming,
  ];
};

const removeAzureEnvironment = (
  current: readonly EnvironmentVar[] | undefined,
  names: readonly string[],
): EnvironmentVar[] => {
  const removeNames = new Set(names);
  return (current ?? []).filter(
    (variable) =>
      variable.name === undefined || !removeNames.has(variable.name),
  );
};

export const withContainerAppSecretEnvironment = (
  app: ContainerApp,
  variables: readonly AzureSecretEnvironmentVariable[],
  containerName = HERMES_CONTAINER_NAME,
): ContainerApp => {
  const env = variables.map(azureSecretEnvironmentVariable);
  const properties = app.properties ?? {};
  const template = properties.template ?? {};
  const containers = template.containers;

  return {
    ...app,
    properties: {
      ...properties,
      template: {
        ...template,
        ...(containers
          ? {
              containers: containers.map((container) =>
                container.name === containerName
                  ? {
                      ...container,
                      env: mergeAzureEnvironment(container.env, env),
                    }
                  : container,
              ),
            }
          : {}),
      },
    },
  };
};

export const withoutContainerAppEnvironment = (
  app: ContainerApp,
  names: readonly string[],
  containerName = HERMES_CONTAINER_NAME,
): ContainerApp => {
  const properties = app.properties ?? {};
  const template = properties.template ?? {};
  const containers = template.containers;

  return {
    ...app,
    properties: {
      ...properties,
      template: {
        ...template,
        ...(containers
          ? {
              containers: containers.map((container) =>
                container.name === containerName
                  ? {
                      ...container,
                      env: removeAzureEnvironment(container.env, names),
                    }
                  : container,
              ),
            }
          : {}),
      },
    },
  };
};

export const desiredContainerApp = (
  spec: AzureContainerAppSpec,
): ContainerApp => ({
  location: spec.location,
  tags: ownershipMetadata(AZURE_OWNERSHIP_SCOPE, spec.identity),
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

export const findContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsGetParams = apiVersionParams,
): Effect.Effect<ContainerApp | undefined, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.find";
    const response = yield* sendAzure(auth, operation, (options) =>
      containerAppsGet(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );

    if (response.status === 200) {
      const success = yield* validateAzureResponseData(
        operation,
        response,
        containerAppsGet200Response,
      );
      yield* validateContainerAppResponse(operation, success);
      return success.data;
    }
    if (response.status === 404) {
      return undefined;
    }
    return yield* failHttpResponse(operation, response);
  });

const listContainerAppsByResourceGroup = (
  auth: AzureAuthContext,
  ref: AzureResourceGroupRef,
  params: ContainerAppsListByResourceGroupParams = apiVersionParams,
): Effect.Effect<containerAppsListByResourceGroupResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.listByResourceGroup";
    const response = yield* sendAzure(auth, operation, (options) =>
      containerAppsListByResourceGroup(
        ref.subscriptionId,
        ref.resourceGroupName,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    const validated = yield* validateAzureResponseData(
      operation,
      success,
      containerAppsListByResourceGroup200Response,
    );
    return yield* validateContainerAppCollectionResponse(operation, validated);
  });

const stringRecordSchema = z.record(z.string(), z.string());
const containerAppRuntimeSchema = z
  .object({
    location: z.string(),
    tags: stringRecordSchema.optional(),
  })
  .passthrough();
const containerAppCollectionRuntimeSchema = z
  .object({
    value: z.array(containerAppRuntimeSchema),
    nextLink: z.string().optional(),
  })
  .passthrough();

const isContainerApp = (value: unknown): value is ContainerApp =>
  containerAppRuntimeSchema.safeParse(value).success;

const isContainerAppCollection = (
  value: unknown,
): value is ContainerAppCollection =>
  containerAppCollectionRuntimeSchema.safeParse(value).success;

const validateContainerAppResponse = <
  TResponse extends { readonly data: unknown },
>(
  operation: string,
  response: TResponse,
): Effect.Effect<TResponse, CloudError> =>
  isContainerApp(response.data)
    ? Effect.succeed(response)
    : Effect.fail(
        new OperationFailed({
          operation,
          message: "Azure Container App response failed validation",
          cause: response.data,
        }),
      );

const validateContainerAppCollectionResponse = <
  TResponse extends { readonly data: unknown },
>(
  operation: string,
  response: TResponse,
): Effect.Effect<TResponse, CloudError> =>
  isContainerAppCollection(response.data)
    ? Effect.succeed(response)
    : Effect.fail(
        new OperationFailed({
          operation,
          message: "Azure Container Apps collection response failed validation",
          cause: response.data,
        }),
      );

const fetchContainerAppCollection = (
  auth: AzureAuthContext,
  operation: string,
  url: string,
): Effect.Effect<ContainerAppCollection, CloudError> =>
  Effect.gen(function* () {
    const authorized = yield* authorizedAzureRequest(auth);
    const response = yield* invokeJsonHttp(operation, () =>
      fetch(url, {
        ...authorized,
        method: "GET",
      }),
    );

    if (response.status !== 200) {
      return yield* failHttpResponse(operation, response);
    }
    const validated = yield* validateAzureResponseData(
      operation,
      response,
      containerAppsListByResourceGroup200Response,
    );
    if (isContainerAppCollection(validated.data)) {
      return validated.data;
    }

    return yield* Effect.fail(
      new OperationFailed({
        operation,
        message: "Azure Container Apps page failed validation",
        cause: response.data,
      }),
    );
  });

const collectContainerAppPages = (
  auth: AzureAuthContext,
  operation: string,
  apps: readonly ContainerApp[],
  nextLink: string | undefined,
): Effect.Effect<readonly ContainerApp[], CloudError> => {
  if (!nextLink) {
    return Effect.succeed(apps);
  }

  return Effect.gen(function* () {
    const next = yield* fetchContainerAppCollection(auth, operation, nextLink);
    return yield* collectContainerAppPages(
      auth,
      operation,
      [...apps, ...next.value],
      next.nextLink,
    );
  });
};

export const listAllContainerAppsByResourceGroup = (
  auth: AzureAuthContext,
  ref: AzureResourceGroupRef,
  params: ContainerAppsListByResourceGroupParams = apiVersionParams,
): Effect.Effect<readonly ContainerApp[], CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.listByResourceGroup";
    const first = yield* listContainerAppsByResourceGroup(auth, ref, params);
    return yield* collectContainerAppPages(
      auth,
      operation,
      first.data.value,
      first.data.nextLink,
    );
  });

export const createOrUpdateContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  app: ContainerApp,
  params: ContainerAppsCreateOrUpdateParams = apiVersionParams,
): Effect.Effect<containerAppsCreateOrUpdateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.createOrUpdate";
    const response = yield* sendAzure(auth, operation, (options) =>
      containerAppsCreateOrUpdate(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        app,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200, 201]);
    return success.status === 200
      ? yield* validateContainerAppResponse(
          operation,
          yield* validateAzureResponseData(
            operation,
            success,
            containerAppsCreateOrUpdate200Response,
          ),
        )
      : yield* validateContainerAppResponse(
          operation,
          yield* validateAzureResponseData(
            operation,
            success,
            containerAppsCreateOrUpdate201Response,
          ),
        );
  });

export const deleteContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsDeleteParams = apiVersionParams,
): Effect.Effect<containerAppsDeleteResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.delete";
    const response = yield* sendAzure(auth, operation, (options) =>
      containerAppsDelete(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    return yield* expectHttpStatus(operation, response, [200, 202, 204]);
  });

export const startContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsStartParams = apiVersionParams,
): Effect.Effect<containerAppsStartResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.start";
    const response = yield* sendAzure(auth, operation, (options) =>
      containerAppsStart(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200, 202]);
    if (success.status === 202) {
      return success;
    }
    const validated = yield* validateAzureResponseData(
      operation,
      success,
      containerAppsStart200Response,
    );
    return yield* validateContainerAppResponse(operation, validated);
  });

export const stopContainerApp = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  params: ContainerAppsStopParams = apiVersionParams,
): Effect.Effect<containerAppsStopResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.stop";
    const response = yield* sendAzure(auth, operation, (options) =>
      containerAppsStop(
        ref.subscriptionId,
        ref.resourceGroupName,
        ref.containerAppName,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200, 202]);
    if (success.status === 202) {
      return success;
    }
    const validated = yield* validateAzureResponseData(
      operation,
      success,
      containerAppsStop200Response,
    );
    return yield* validateContainerAppResponse(operation, validated);
  });
