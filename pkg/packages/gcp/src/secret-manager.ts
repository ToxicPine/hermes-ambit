import { Effect } from "effect";

import {
  OperationFailed,
  expectHttpSuccess,
  ownershipMetadata,
  type CloudError,
  type DeploymentIdentity,
} from "@cardelli/shared";

import { sendGcp, type GcpAuthContext } from "./client.js";
import {
  secretmanagerProjectsSecretsAddVersion,
  secretmanagerProjectsSecretsCreate,
  secretmanagerProjectsSecretsDelete,
  secretmanagerProjectsSecretsList,
  secretmanagerProjectsSecretsVersionsAccess,
  type secretmanagerProjectsSecretsAddVersionResponseSuccess,
  type secretmanagerProjectsSecretsCreateResponseSuccess,
  type secretmanagerProjectsSecretsDeleteResponseSuccess,
  type secretmanagerProjectsSecretsListResponseSuccess,
  type secretmanagerProjectsSecretsVersionsAccessResponseSuccess,
} from "./generated/secret-manager/client";
import type { Secret } from "./generated/secret-manager/model/secret";
import type { SecretVersion } from "./generated/secret-manager/model/secretVersion";
import type { SecretmanagerProjectsSecretsListParams } from "./generated/secret-manager/model/secretmanagerProjectsSecretsListParams";

export type GcpSecretRef = {
  readonly projectId: string;
  readonly secretId: string;
};

export type GcpSecretValue = GcpSecretRef & {
  readonly value: string;
  readonly owner?: DeploymentIdentity;
};

export const gcpProjectName = (projectId: string) => `projects/${projectId}`;

export const gcpSecretName = (ref: GcpSecretRef) =>
  `${gcpProjectName(ref.projectId)}/secrets/${ref.secretId}`;

export const gcpSecretVersionName = (
  ref: GcpSecretRef,
  version = "latest",
) => `${gcpSecretName(ref)}/versions/${version}`;

const base64Encode = (value: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64Decode = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

const missingSecret = (
  operation: string,
  ref: GcpSecretRef,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    new OperationFailed({
      operation,
      message: `Secret ${gcpSecretName(ref)} does not exist`,
    }),
  );

export const findSecret = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
): Effect.Effect<Secret | undefined, CloudError> =>
  Effect.gen(function* () {
    const listed = yield* listSecrets(auth, ref.projectId, {
      filter: `name:${ref.secretId}`,
      pageSize: 25000,
    });
    return listed.data.secrets?.find((secret) => secret.name === gcpSecretName(ref));
  });

export const listSecrets = (
  auth: GcpAuthContext,
  projectId: string,
  params?: SecretmanagerProjectsSecretsListParams,
): Effect.Effect<secretmanagerProjectsSecretsListResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.list";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      secretmanagerProjectsSecretsList(gcpProjectName(projectId), params, options),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const createSecret = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
  owner?: DeploymentIdentity,
): Effect.Effect<secretmanagerProjectsSecretsCreateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.create";
    const secret: Secret = owner
      ? {
          replication: { automatic: {} },
          labels: ownershipMetadata("gcp", owner),
        }
      : {
          replication: { automatic: {} },
        };
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      secretmanagerProjectsSecretsCreate(
        gcpProjectName(ref.projectId),
        secret,
        { secretId: ref.secretId },
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const addSecretVersion = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
  value: string,
): Effect.Effect<secretmanagerProjectsSecretsAddVersionResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.addVersion";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      secretmanagerProjectsSecretsAddVersion(
        gcpSecretName(ref),
        {
          payload: {
            data: base64Encode(value),
          },
        },
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const putSecretValue = (
  auth: GcpAuthContext,
  secret: GcpSecretValue,
): Effect.Effect<SecretVersion, CloudError> =>
  Effect.gen(function* () {
    const existing = yield* findSecret(auth, secret);
    if (!existing) {
      yield* createSecret(auth, secret, secret.owner);
    }

    const version = yield* addSecretVersion(auth, secret, secret.value);
    return version.data;
  });

export const readSecretValue = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
): Effect.Effect<string, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.access";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      secretmanagerProjectsSecretsVersionsAccess(
        gcpSecretVersionName(ref),
        options,
      ),
    );
    const success: secretmanagerProjectsSecretsVersionsAccessResponseSuccess =
      yield* expectHttpSuccess(operation, response);
    return base64Decode(success.data.payload?.data ?? "");
  });

export const deleteSecret = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
): Effect.Effect<secretmanagerProjectsSecretsDeleteResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const existing = yield* findSecret(auth, ref);
    if (!existing) {
      return yield* missingSecret("gcp.secretmanager.secrets.delete", ref);
    }

    const operation = "gcp.secretmanager.secrets.delete";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      secretmanagerProjectsSecretsDelete(gcpSecretName(ref), undefined, options),
    );
    return yield* expectHttpSuccess(operation, response);
  });
