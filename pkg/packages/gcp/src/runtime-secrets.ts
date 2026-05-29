import { Effect } from "effect";

import {
  emitCloudEvent,
  validateHermesDeploymentIdentity,
  validateRuntimeSecretName,
  type CloudError,
} from "@cardelli/shared";

import type { GcpAuthContext } from "./client.js";
import {
  deleteGcpServiceEnvironment,
  gcpRuntimeSecretNamesFromService,
  putGcpServiceSecretEnvironmentForService,
  requireGcpDeploymentService,
  requireGcpRuntimeContainer,
  requireGcpRuntimeServiceAccount,
} from "./deployment.js";
import type { GcpDeploymentRef, GcpStatus } from "./deployment-types.js";
import {
  deleteSecret,
  gcpSecretIdForRuntimeName,
  putSecretValue,
} from "./secret-manager.js";

type GcpRuntimeSecretRef = GcpDeploymentRef & {
  readonly runtimeName: string;
};

type GcpRuntimeSecretValue = GcpRuntimeSecretRef & {
  readonly value: string;
};

export const listGcpRuntimeSecrets = (
  auth: GcpAuthContext,
  ref: GcpDeploymentRef,
): Effect.Effect<readonly string[], CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.runtimeSecrets.list";
    yield* validateHermesDeploymentIdentity(operation, ref);
    const service = yield* requireGcpDeploymentService(auth, ref);
    yield* requireGcpRuntimeContainer(service, operation);
    return gcpRuntimeSecretNamesFromService(ref, service);
  });

export const putGcpRuntimeSecret = (
  auth: GcpAuthContext,
  secret: GcpRuntimeSecretValue,
): Effect.Effect<GcpStatus, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.runtimeSecrets.put";
    yield* validateHermesDeploymentIdentity(operation, secret);
    yield* validateRuntimeSecretName(operation, secret.runtimeName);
    yield* emitCloudEvent({
      level: "info",
      scope: "secrets",
      operation: "secret.update",
      resource: secret.runtimeName,
      message: `Updating runtime secret ${secret.runtimeName}`,
    });
    const service = yield* requireGcpDeploymentService(auth, secret);
    yield* requireGcpRuntimeContainer(service, operation);
    const serviceAccount = yield* requireGcpRuntimeServiceAccount(
      service,
      operation,
    );

    const secretId = gcpSecretIdForRuntimeName(secret, secret.runtimeName);
    yield* putSecretValue(auth, {
      projectId: secret.projectId,
      secretId,
      value: secret.value,
      owner: secret,
    });
    return yield* putGcpServiceSecretEnvironmentForService(
      auth,
      secret,
      service,
      serviceAccount,
      [{ name: secret.runtimeName, secret: secretId, version: "latest" }],
    );
  });

export const deleteGcpRuntimeSecret = (
  auth: GcpAuthContext,
  secret: GcpRuntimeSecretRef,
): Effect.Effect<GcpStatus, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.runtimeSecrets.delete";
    yield* validateHermesDeploymentIdentity(operation, secret);
    yield* validateRuntimeSecretName(operation, secret.runtimeName);
    yield* emitCloudEvent({
      level: "info",
      scope: "secrets",
      operation: "secret.delete",
      resource: secret.runtimeName,
      message: `Deleting runtime secret ${secret.runtimeName}`,
    });

    const status = yield* deleteGcpServiceEnvironment(auth, secret, [
      secret.runtimeName,
    ]);
    yield* deleteSecret(auth, {
      projectId: secret.projectId,
      secretId: gcpSecretIdForRuntimeName(secret, secret.runtimeName),
      owner: secret,
    });
    return status;
  });
