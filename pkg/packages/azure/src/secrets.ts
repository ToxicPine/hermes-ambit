import { Effect } from "effect";

import {
  HERMES_CONTAINER_NAME,
  OperationFailed,
  OWNERSHIP_DEPLOYMENT_KEY,
  OWNERSHIP_SCOPE_KEY,
  ResourceConflict,
  isRuntimeSecretName,
  runtimeSecretSlugFromName,
  type CloudError,
} from "@cardelli/shared";

import type { Secret } from "./generated/container-apps/model/CommonDefinitions/secret";
import type { ContainerApp } from "./generated/container-apps/model/containerApp";
import { AZURE_OWNERSHIP_SCOPE } from "./constants.js";
import { waitAzureLongRunningOperation, type AzureAuthContext } from "./client.js";
import {
  createOrUpdateContainerApp,
  findContainerApp,
  withContainerAppSecretEnvironment,
  withoutContainerAppEnvironment,
  type AzureSecretEnvironmentVariable,
} from "./container-apps.js";
import type { AzureContainerAppRef } from "./deployment-types.js";

type AzureContainerAppSecret = Secret;

export const azureSecretNameForRuntimeName = (name: string): string =>
  runtimeSecretSlugFromName(name);

const missingContainerApp = (
  operation: string,
  ref: AzureContainerAppRef,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    new OperationFailed({
      operation,
      message: `Container app ${ref.containerAppName} does not exist`,
    }),
  );

const isDeploymentContainerApp = (
  ref: AzureContainerAppRef,
  app: ContainerApp,
): boolean =>
  app.tags?.[OWNERSHIP_SCOPE_KEY] === AZURE_OWNERSHIP_SCOPE &&
  app.tags?.[OWNERSHIP_DEPLOYMENT_KEY] === ref.containerAppName;

const requireDeploymentContainerApp = (
  auth: AzureAuthContext,
  operation: string,
  ref: AzureContainerAppRef,
): Effect.Effect<ContainerApp, CloudError> =>
  Effect.gen(function* () {
    const existing = yield* findContainerApp(auth, ref);
    if (!existing) {
      return yield* missingContainerApp(operation, ref);
    }
    if (!isDeploymentContainerApp(ref, existing)) {
      return yield* Effect.fail(
        new ResourceConflict({
          resource: existing.id ?? ref.containerAppName,
          message: "Container App name is already used by another deployment",
        }),
      );
    }
    return existing;
  });

const requireContainerAppRuntimeContainer = (
  operation: string,
  app: ContainerApp,
): Effect.Effect<void, OperationFailed> =>
  app.properties?.template?.containers?.some(
    (container) => container.name === HERMES_CONTAINER_NAME,
  ) === true
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation,
          message:
            "Container App must include the Hermes container before runtime secrets can be wired.",
        }),
      );

export const readContainerAppSecrets = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
): Effect.Effect<readonly AzureContainerAppSecret[], CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.readSecretConfig";
    const existing = yield* requireDeploymentContainerApp(auth, operation, ref);
    return existing.properties?.configuration?.secrets ?? [];
  });

export const readContainerAppRuntimeSecretNames = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
): Effect.Effect<readonly string[], CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.readRuntimeSecrets";
    const existing = yield* requireDeploymentContainerApp(auth, operation, ref);
    yield* requireContainerAppRuntimeContainer(operation, existing);
    const container = existing.properties?.template?.containers?.find(
      (entry) => entry.name === HERMES_CONTAINER_NAME,
    );
    return (container?.env ?? []).flatMap((variable) =>
      variable.name &&
      variable.secretRef &&
      isRuntimeSecretName(variable.name) &&
      azureSecretNameForRuntimeName(variable.name) === variable.secretRef
        ? [variable.name]
        : [],
    );
  });

const mergeContainerAppSecrets = (
  current: readonly AzureContainerAppSecret[] | undefined,
  incoming: readonly AzureContainerAppSecret[],
): AzureContainerAppSecret[] => {
  const incomingNames = new Set(
    incoming.flatMap((secret) =>
      secret.name === undefined ? [] : [secret.name],
    ),
  );
  return [
    ...(current ?? []).filter(
      (secret) => secret.name === undefined || !incomingNames.has(secret.name),
    ),
    ...incoming,
  ];
};

const withContainerAppSecrets = (
  app: ContainerApp,
  secrets: readonly AzureContainerAppSecret[],
): ContainerApp => {
  const properties = app.properties ?? {};
  const configuration = properties.configuration ?? {};
  return {
    ...app,
    properties: {
      ...properties,
      configuration: {
        ...configuration,
        secrets: mergeContainerAppSecrets(configuration.secrets, secrets),
      },
    },
  };
};

const withoutContainerAppSecrets = (
  app: ContainerApp,
  names: readonly string[],
): ContainerApp => {
  const removeNames = new Set(names);
  const properties = app.properties ?? {};
  const configuration = properties.configuration ?? {};
  return {
    ...app,
    properties: {
      ...properties,
      configuration: {
        ...configuration,
        secrets: (configuration.secrets ?? []).filter(
          (secret) => secret.name === undefined || !removeNames.has(secret.name),
        ),
      },
    },
  };
};

export const putContainerAppSecretsAndEnvironment = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  secrets: readonly AzureContainerAppSecret[],
  variables: readonly AzureSecretEnvironmentVariable[],
) =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.runtimeSecrets.put";
    const existing = yield* requireDeploymentContainerApp(auth, operation, ref);
    yield* requireContainerAppRuntimeContainer(operation, existing);

    const updated = yield* createOrUpdateContainerApp(
      auth,
      ref,
      withContainerAppSecretEnvironment(
        withContainerAppSecrets(existing, secrets),
        variables,
      ),
    );

    yield* waitAzureLongRunningOperation(auth, operation, updated);
    return (yield* findContainerApp(auth, ref)) ?? updated.data;
  });

export const deleteContainerAppSecretsAndEnvironment = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  secretNames: readonly string[],
  environmentNames: readonly string[],
) =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.runtimeSecrets.delete";
    const existing = yield* requireDeploymentContainerApp(auth, operation, ref);
    yield* requireContainerAppRuntimeContainer(operation, existing);

    const updated = yield* createOrUpdateContainerApp(
      auth,
      ref,
      withoutContainerAppEnvironment(
        withoutContainerAppSecrets(existing, secretNames),
        environmentNames,
      ),
    );

    yield* waitAzureLongRunningOperation(auth, operation, updated);
    return (yield* findContainerApp(auth, ref)) ?? updated.data;
  });
