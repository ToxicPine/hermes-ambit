import { Effect } from "effect";

import {
  emitCloudEvent,
  validateHermesDeploymentIdentity,
  validateRuntimeSecretName,
  type CloudError,
} from "@cardelli/shared";

import type { AzureAuthContext } from "./client.js";
import { azureContainerAppRef, makeAzureDriver } from "./deployment.js";
import type { AzureDeploymentRef, AzureStatus } from "./deployment-types.js";
import {
  azureSecretNameForRuntimeName,
  deleteContainerAppSecretsAndEnvironment,
  putContainerAppSecretsAndEnvironment,
  readContainerAppRuntimeSecretNames,
} from "./secrets.js";

type AzureRuntimeSecretRef = AzureDeploymentRef & {
  readonly runtimeName: string;
};

type AzureRuntimeSecretValue = AzureRuntimeSecretRef & {
  readonly value: string;
};

export const listAzureRuntimeSecrets = (
  auth: AzureAuthContext,
  ref: AzureDeploymentRef,
): Effect.Effect<readonly string[], CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.runtimeSecrets.list";
    yield* validateHermesDeploymentIdentity(operation, ref);
    return yield* readContainerAppRuntimeSecretNames(
      auth,
      azureContainerAppRef(ref),
    );
  });

export const putAzureRuntimeSecret = (
  auth: AzureAuthContext,
  secret: AzureRuntimeSecretValue,
): Effect.Effect<AzureStatus, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.runtimeSecrets.put";
    yield* validateHermesDeploymentIdentity(operation, secret);
    yield* validateRuntimeSecretName(operation, secret.runtimeName);
    yield* emitCloudEvent({
      level: "info",
      scope: "secrets",
      operation: "secret.update",
      resource: secret.runtimeName,
      message: `Updating runtime secret ${secret.runtimeName}`,
    });

    const secretName = azureSecretNameForRuntimeName(secret.runtimeName);
    const app = azureContainerAppRef(secret);
    yield* putContainerAppSecretsAndEnvironment(
      auth,
      app,
      [{ name: secretName, value: secret.value }],
      [{ name: secret.runtimeName, secretRef: secretName }],
    );
    return yield* makeAzureDriver(auth).restart(secret);
  });

export const deleteAzureRuntimeSecret = (
  auth: AzureAuthContext,
  secret: AzureRuntimeSecretRef,
): Effect.Effect<AzureStatus, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.runtimeSecrets.delete";
    yield* validateHermesDeploymentIdentity(operation, secret);
    yield* validateRuntimeSecretName(operation, secret.runtimeName);
    yield* emitCloudEvent({
      level: "info",
      scope: "secrets",
      operation: "secret.delete",
      resource: secret.runtimeName,
      message: `Deleting runtime secret ${secret.runtimeName}`,
    });

    const app = azureContainerAppRef(secret);
    yield* deleteContainerAppSecretsAndEnvironment(
      auth,
      app,
      [azureSecretNameForRuntimeName(secret.runtimeName)],
      [secret.runtimeName],
    );
    return yield* makeAzureDriver(auth).restart(secret);
  });
