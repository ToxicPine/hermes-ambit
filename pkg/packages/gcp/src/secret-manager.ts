import { Effect } from "effect";

import {
  OWNERSHIP_DEPLOYMENT_KEY,
  OWNERSHIP_SCOPE_KEY,
  OperationFailed,
  ResourceConflict,
  expectHttpStatus,
  failHttpResponse,
  hermesName,
  invokeJsonHttp,
  ownershipMetadata,
  runtimeSecretSlugFromName,
  type CloudError,
  type DeploymentIdentity,
} from "@cardelli/shared";

import {
  authorizedGcpRequest,
  sendGcp,
  validateGcpResponseData,
  type GcpAuthContext,
} from "./client.js";
import { GCP_OWNERSHIP_SCOPE } from "./constants.js";
import {
  secretmanagerProjectsSecretsAddVersion,
  secretmanagerProjectsSecretsCreate,
  secretmanagerProjectsSecretsDelete,
  secretmanagerProjectsSecretsList,
  type secretmanagerProjectsSecretsAddVersionResponseSuccess,
  type secretmanagerProjectsSecretsCreateResponseSuccess,
  type secretmanagerProjectsSecretsDeleteResponseSuccess,
  type secretmanagerProjectsSecretsListResponseSuccess,
} from "./generated/secret-manager/client";
import {
  secretmanagerProjectsSecretsAddVersion200Response,
  secretmanagerProjectsSecretsCreate200Response,
  secretmanagerProjectsSecretsDelete200Response,
  secretmanagerProjectsSecretsList200Response,
} from "./generated/secret-manager/client/secretManagerAPI.zod";
import type { Secret } from "./generated/secret-manager/model/secret";
import type { SecretVersion } from "./generated/secret-manager/model/secretVersion";
import type { SecretmanagerProjectsSecretsListParams } from "./generated/secret-manager/model/secretmanagerProjectsSecretsListParams";

export type GcpSecretRef = {
  readonly projectId: string;
  readonly secretId: string;
};

export type GcpOwnedSecretRef = GcpSecretRef & {
  readonly owner: DeploymentIdentity;
};

export type GcpSecretValue = GcpOwnedSecretRef & {
  readonly value: string;
};

export type GcpIamCondition = {
  readonly title?: string;
  readonly description?: string;
  readonly expression?: string;
};

export type GcpIamBinding = {
  readonly role?: string;
  readonly members?: readonly string[];
  readonly condition?: GcpIamCondition;
};

export type GcpIamPolicy = {
  readonly version?: number;
  readonly etag?: string;
  readonly bindings?: readonly GcpIamBinding[];
};

const secretAccessorRole = "roles/secretmanager.secretAccessor";

const gcpProjectName = (projectId: string) => `projects/${projectId}`;

const gcpSecretName = (ref: GcpSecretRef) =>
  `${gcpProjectName(ref.projectId)}/secrets/${ref.secretId}`;

export const gcpSecretIdForRuntimeName = (
  owner: DeploymentIdentity,
  name: string,
): string => `${hermesName(owner)}-${runtimeSecretSlugFromName(name)}`;

export const gcpServiceAccountMember = (email: string): string =>
  email.startsWith("serviceAccount:") ? email : `serviceAccount:${email}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object";

const stringField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
};

const numberField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined => {
  const entry = value[key];
  return typeof entry === "number" ? entry : undefined;
};

const stringArrayField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined => {
  const entry = value[key];
  return Array.isArray(entry) &&
    entry.every((item) => typeof item === "string")
    ? entry
    : undefined;
};

const iamConditionFromValue = (
  value: unknown,
): GcpIamCondition | undefined => {
  if (!isRecord(value)) return undefined;
  const title = stringField(value, "title");
  const description = stringField(value, "description");
  const expression = stringField(value, "expression");
  const condition = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(expression ? { expression } : {}),
  };
  return Object.keys(condition).length > 0 ? condition : undefined;
};

const iamBindingFromValue = (value: unknown): GcpIamBinding | undefined => {
  if (!isRecord(value)) return undefined;
  const role = stringField(value, "role");
  const members = stringArrayField(value, "members");
  const condition = iamConditionFromValue(value.condition);
  return {
    ...(role ? { role } : {}),
    ...(members ? { members } : {}),
    ...(condition ? { condition } : {}),
  };
};

const iamPolicyFromValue = (value: unknown): GcpIamPolicy | undefined => {
  if (!isRecord(value)) return undefined;
  const version = numberField(value, "version");
  const etag = stringField(value, "etag");
  const bindingsValue = value.bindings;
  const bindings = Array.isArray(bindingsValue)
    ? bindingsValue.flatMap((binding) => {
        const parsed = iamBindingFromValue(binding);
        return parsed ? [parsed] : [];
      })
    : undefined;

  return {
    ...(version !== undefined ? { version } : {}),
    ...(etag ? { etag } : {}),
    ...(bindings ? { bindings } : {}),
  };
};

const secretIamPolicyUrl = (ref: GcpSecretRef, action: string): string =>
  `https://secretmanager.googleapis.com/v1/${gcpSecretName(ref)}:${action}`;

const getSecretIamPolicy = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
): Effect.Effect<GcpIamPolicy, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.getIamPolicy";
    const authorized = yield* authorizedGcpRequest(auth);
    const url = new URL(secretIamPolicyUrl(ref, "getIamPolicy"));
    url.searchParams.set("options.requestedPolicyVersion", "3");
    const response = yield* invokeJsonHttp(operation, () =>
      fetch(url, {
        ...authorized,
        method: "GET",
      }),
    );

    if (response.status !== 200) {
      return yield* failHttpResponse(operation, response);
    }

    const policy = iamPolicyFromValue(response.data);
    return policy
      ? policy
      : yield* Effect.fail(
          new OperationFailed({
            operation,
            message: "GCP secret IAM policy response failed validation",
            cause: response.data,
          }),
        );
  });

const setSecretIamPolicy = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
  policy: GcpIamPolicy,
): Effect.Effect<GcpIamPolicy, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.setIamPolicy";
    const authorized = yield* authorizedGcpRequest(auth);
    const headers = new Headers(authorized.headers);
    headers.set("Content-Type", "application/json");
    const response = yield* invokeJsonHttp(operation, () =>
      fetch(secretIamPolicyUrl(ref, "setIamPolicy"), {
        ...authorized,
        method: "POST",
        headers,
        body: JSON.stringify({ policy }),
      }),
    );

    if (response.status !== 200) {
      return yield* failHttpResponse(operation, response);
    }

    const next = iamPolicyFromValue(response.data);
    return next
      ? next
      : yield* Effect.fail(
          new OperationFailed({
            operation,
            message: "GCP secret IAM policy response failed validation",
            cause: response.data,
          }),
        );
  });

export const withSecretAccessorMember = (
  policy: GcpIamPolicy,
  member: string,
): GcpIamPolicy => {
  const bindings = policy.bindings ?? [];
  const existing = bindings.find((binding) => binding.role === secretAccessorRole);
  if (existing?.members?.includes(member)) {
    return policy;
  }

  return {
    ...policy,
    bindings: existing
      ? bindings.map((binding) =>
          binding === existing
            ? {
                ...binding,
                members: [...(binding.members ?? []), member].sort(),
              }
            : binding,
        )
      : [
          ...bindings,
          {
            role: secretAccessorRole,
            members: [member],
          },
        ],
  };
};

export const grantSecretAccessorToServiceAccount = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
  serviceAccountEmail: string,
): Effect.Effect<GcpIamPolicy, CloudError> =>
  Effect.gen(function* () {
    const current = yield* getSecretIamPolicy(auth, ref);
    const next = withSecretAccessorMember(
      current,
      gcpServiceAccountMember(serviceAccountEmail),
    );
    return next === current ? current : yield* setSecretIamPolicy(auth, ref, next);
  });

const base64Encode = (value: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const findSecret = (
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

const secretMatchesOwner = (
  secret: Secret,
  owner: DeploymentIdentity,
): boolean =>
  secret.labels?.[OWNERSHIP_SCOPE_KEY] === GCP_OWNERSHIP_SCOPE &&
  secret.labels?.[OWNERSHIP_DEPLOYMENT_KEY] === hermesName(owner);

const assertOwnedSecret = (
  ref: GcpSecretRef,
  secret: Secret | undefined,
  owner: DeploymentIdentity,
): Effect.Effect<void, ResourceConflict> => {
  if (!secret || secretMatchesOwner(secret, owner)) {
    return Effect.void;
  }

  return Effect.fail(
    new ResourceConflict({
      resource: secret.name ?? gcpSecretName(ref),
      message: "Secret name is already used by another deployment",
    }),
  );
};

const listSecrets = (
  auth: GcpAuthContext,
  projectId: string,
  params?: SecretmanagerProjectsSecretsListParams,
): Effect.Effect<secretmanagerProjectsSecretsListResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.list";
    const response = yield* sendGcp(auth, operation, (options) =>
      secretmanagerProjectsSecretsList(gcpProjectName(projectId), params, options),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      secretmanagerProjectsSecretsList200Response,
    );
  });

const createSecret = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
  owner?: DeploymentIdentity,
): Effect.Effect<secretmanagerProjectsSecretsCreateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.create";
    const secret: Secret = owner
      ? {
          replication: { automatic: {} },
          labels: ownershipMetadata(GCP_OWNERSHIP_SCOPE, owner),
        }
      : {
          replication: { automatic: {} },
        };
    const response = yield* sendGcp(auth, operation, (options) =>
      secretmanagerProjectsSecretsCreate(
        gcpProjectName(ref.projectId),
        secret,
        { secretId: ref.secretId },
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      secretmanagerProjectsSecretsCreate200Response,
    );
  });

const addSecretVersion = (
  auth: GcpAuthContext,
  ref: GcpSecretRef,
  value: string,
): Effect.Effect<secretmanagerProjectsSecretsAddVersionResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.secretmanager.secrets.addVersion";
    const response = yield* sendGcp(auth, operation, (options) =>
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
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      secretmanagerProjectsSecretsAddVersion200Response,
    );
  });

export const putSecretValue = (
  auth: GcpAuthContext,
  secret: GcpSecretValue,
): Effect.Effect<SecretVersion, CloudError> =>
  Effect.gen(function* () {
    const existing = yield* findSecret(auth, secret);
    yield* assertOwnedSecret(secret, existing, secret.owner);
    if (!existing) {
      yield* createSecret(auth, secret, secret.owner);
    }

    const version = yield* addSecretVersion(auth, secret, secret.value);
    return version.data;
  });

export const deleteSecret = (
  auth: GcpAuthContext,
  ref: GcpOwnedSecretRef,
): Effect.Effect<
  secretmanagerProjectsSecretsDeleteResponseSuccess | undefined,
  CloudError
> =>
  Effect.gen(function* () {
    const existing = yield* findSecret(auth, ref);
    yield* assertOwnedSecret(ref, existing, ref.owner);
    if (!existing) {
      return undefined;
    }

    const operation = "gcp.secretmanager.secrets.delete";
    const response = yield* sendGcp(auth, operation, (options) =>
      secretmanagerProjectsSecretsDelete(gcpSecretName(ref), undefined, options),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      secretmanagerProjectsSecretsDelete200Response,
    );
  });
