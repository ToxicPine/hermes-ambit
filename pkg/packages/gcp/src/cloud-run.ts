import { Effect } from "effect";

import {
  HERMES_CONTAINER_NAME,
  HERMES_DATA_MOUNT_PATH,
  HERMES_DATA_VOLUME_NAME,
  HERMES_GATEWAY_PORT,
  HERMES_NIX_MOUNT_PATH,
  HERMES_NIX_VOLUME_NAME,
  UNIVERSAL_HERMES_IMAGE,
  expectHttpStatus,
  failHttpResponse,
  hermesName,
  ownershipMetadata,
  type CloudError,
  type DeploymentIdentity,
} from "@cardelli/shared";
import type { GcpNfsState } from "./deployment-types.js";

import {
  runProjectsLocationsOperationsWait,
  runProjectsLocationsServicesCreate,
  runProjectsLocationsServicesDelete,
  runProjectsLocationsServicesGet,
  runProjectsLocationsServicesList,
  runProjectsLocationsServicesPatch,
  type runProjectsLocationsOperationsWaitResponseSuccess,
  type runProjectsLocationsServicesCreateResponseSuccess,
  type runProjectsLocationsServicesDeleteResponseSuccess,
  type runProjectsLocationsServicesListResponseSuccess,
  type runProjectsLocationsServicesPatchResponseSuccess,
} from "./generated/run/client";
import {
  runProjectsLocationsOperationsWait200Response,
  runProjectsLocationsServicesCreate200Response,
  runProjectsLocationsServicesDelete200Response,
  runProjectsLocationsServicesGet200Response,
  runProjectsLocationsServicesList200Response,
  runProjectsLocationsServicesPatch200Response,
} from "./generated/run/client/cloudRunAdminAPI.zod";
import { GCP_OWNERSHIP_SCOPE } from "./constants.js";
import type { GoogleLongrunningWaitOperationRequest } from "./generated/run/model/googleLongrunningWaitOperationRequest";
import type { GoogleCloudRunV2Service } from "./generated/run/model/googleCloudRunV2Service";
import type { GoogleCloudRunV2Container } from "./generated/run/model/googleCloudRunV2Container";
import type { GoogleCloudRunV2EnvVar } from "./generated/run/model/googleCloudRunV2EnvVar";
import type { GoogleCloudRunV2Volume } from "./generated/run/model/googleCloudRunV2Volume";
import { GoogleCloudRunV2ServiceIngress } from "./generated/run/model/googleCloudRunV2ServiceIngress";
import type { RunProjectsLocationsServicesCreateParams } from "./generated/run/model/runProjectsLocationsServicesCreateParams";
import type { RunProjectsLocationsServicesDeleteParams } from "./generated/run/model/runProjectsLocationsServicesDeleteParams";
import type { RunProjectsLocationsServicesListParams } from "./generated/run/model/runProjectsLocationsServicesListParams";
import type { RunProjectsLocationsServicesPatchParams } from "./generated/run/model/runProjectsLocationsServicesPatchParams";
import {
  sendGcp,
  validateGcpResponseData,
  type GcpAuthContext,
} from "./client.js";

export type GcpLocationRef = {
  readonly projectId: string;
  readonly region: string;
};

export type GcpServiceRef = GcpLocationRef & {
  readonly serviceName: string;
};

type GcpOperationRef = {
  readonly name: string;
};

export type CloudRunServiceInput = Parameters<
  typeof runProjectsLocationsServicesCreate
>[1];

type CloudRunServiceSpec = {
  readonly identity: DeploymentIdentity;
  readonly projectId: string;
  readonly region: string;
  readonly state: GcpNfsState;
  readonly serviceAccount?: string;
};

export type CloudRunSecretEnvironmentVariable = {
  readonly name: string;
  readonly secret: string;
  readonly version: string;
};

export const gcpLocationName = (ref: GcpLocationRef) =>
  `projects/${ref.projectId}/locations/${ref.region}`;

export const gcpServiceResourceName = (ref: GcpServiceRef) =>
  `${gcpLocationName(ref)}/services/${ref.serviceName}`;

const cloudRunSecretEnvironmentVariable = (
  variable: CloudRunSecretEnvironmentVariable,
): GoogleCloudRunV2EnvVar => ({
  name: variable.name,
  valueSource: {
    secretKeyRef: {
      secret: variable.secret,
      version: variable.version,
    },
  },
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

const findCloudRunContainer = (
  containers: readonly GoogleCloudRunV2Container[] | undefined,
  name: string | undefined,
) => containers?.find((container) => container.name === name);

const projectCloudRunEnvironment = (
  current: readonly GoogleCloudRunV2EnvVar[] | undefined,
  expected: readonly GoogleCloudRunV2EnvVar[] | undefined,
) =>
  expected?.map((variable) =>
    variable.name === undefined
      ? variable
      : current?.find((entry) => entry.name === variable.name),
  );

const projectCloudRunContainer = (
  container: GoogleCloudRunV2Container | undefined,
  expected: GoogleCloudRunV2Container | undefined,
) =>
  container
    ? {
        name: container.name,
        image: container.image,
        ports: container.ports?.map((port) => ({
          containerPort: port.containerPort,
        })),
        volumeMounts: container.volumeMounts?.map((mount) => ({
          name: mount.name,
          mountPath: mount.mountPath,
        })),
        ...(expected?.env
          ? { env: projectCloudRunEnvironment(container.env, expected.env) }
          : {}),
      }
    : undefined;

const projectCloudRunVolume = (volume: GoogleCloudRunV2Volume | undefined) =>
  volume
    ? {
        name: volume.name,
        nfs: volume.nfs
          ? {
              server: volume.nfs.server,
              path: volume.nfs.path,
            }
          : undefined,
      }
    : undefined;

const projectCloudRunVolumes = (
  volumes: readonly GoogleCloudRunV2Volume[] | undefined,
) =>
  [HERMES_DATA_VOLUME_NAME, HERMES_NIX_VOLUME_NAME].map((name) =>
    projectCloudRunVolume(volumes?.find((volume) => volume.name === name)),
  );

const cloudRunContainerMatches = (
  current: readonly GoogleCloudRunV2Container[] | undefined,
  expected: GoogleCloudRunV2Container,
): boolean =>
  sameJsonShape(
    projectCloudRunContainer(
      findCloudRunContainer(current, expected.name),
      expected,
    ),
    projectCloudRunContainer(expected, expected),
  );

export const cloudRunServiceMatchesInput = (
  current: GoogleCloudRunV2Service,
  expected: CloudRunServiceInput,
): boolean => {
  const expectedContainer = expected.template?.containers?.find(
    (container) => container.name === HERMES_CONTAINER_NAME,
  );

  return (
    current.name === expected.name &&
    includesMetadata(current.labels, expected.labels) &&
    current.ingress === expected.ingress &&
    current.invokerIamDisabled === expected.invokerIamDisabled &&
    (expected.template?.serviceAccount === undefined ||
      current.template?.serviceAccount === expected.template.serviceAccount) &&
    (!expectedContainer ||
      cloudRunContainerMatches(
        current.template?.containers,
        expectedContainer,
      )) &&
    sameJsonShape(
      projectCloudRunVolumes(current.template?.volumes),
      projectCloudRunVolumes(expected.template?.volumes),
    )
  );
};

const preserveCloudRunContainerRuntime = (
  desired: GoogleCloudRunV2Container,
  current: GoogleCloudRunV2Container | undefined,
): GoogleCloudRunV2Container => ({
  ...desired,
  ...(desired.env === undefined && current?.env ? { env: current.env } : {}),
});

export const mergeCloudRunServiceInput = (
  desired: CloudRunServiceInput,
  current: GoogleCloudRunV2Service,
): CloudRunServiceInput => {
  const desiredTemplate = desired.template ?? {};
  const currentTemplate = current.template ?? {};
  const desiredContainers = desiredTemplate.containers;

  return {
    ...desired,
    labels: {
      ...(current.labels ?? {}),
      ...(desired.labels ?? {}),
    },
    template: {
      ...desiredTemplate,
      ...(desiredTemplate.serviceAccount === undefined &&
      currentTemplate.serviceAccount
        ? { serviceAccount: currentTemplate.serviceAccount }
        : {}),
      ...(desiredContainers
        ? {
            containers: desiredContainers.map((container) =>
              preserveCloudRunContainerRuntime(
                container,
                findCloudRunContainer(
                  currentTemplate.containers,
                  container.name,
                ),
              ),
            ),
          }
        : {}),
    },
  };
};

const mergeCloudRunEnvironment = (
  current: readonly GoogleCloudRunV2EnvVar[] | undefined,
  incoming: readonly GoogleCloudRunV2EnvVar[],
): GoogleCloudRunV2EnvVar[] => {
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

const removeCloudRunEnvironment = (
  current: readonly GoogleCloudRunV2EnvVar[] | undefined,
  names: readonly string[],
): GoogleCloudRunV2EnvVar[] => {
  const removeNames = new Set(names);
  return (current ?? []).filter(
    (variable) =>
      variable.name === undefined || !removeNames.has(variable.name),
  );
};

export const withCloudRunSecretEnvironment = (
  service: CloudRunServiceInput,
  variables: readonly CloudRunSecretEnvironmentVariable[],
  containerName = HERMES_CONTAINER_NAME,
): CloudRunServiceInput => {
  const env = variables.map(cloudRunSecretEnvironmentVariable);
  const containers = service.template?.containers;
  return {
    ...service,
    template: {
      ...service.template,
      ...(containers
        ? {
            containers: containers.map((container) =>
              container.name === containerName
                ? {
                    ...container,
                    env: mergeCloudRunEnvironment(container.env, env),
                  }
                : container,
            ),
          }
        : {}),
    },
  };
};

export const withoutCloudRunEnvironment = (
  service: CloudRunServiceInput,
  names: readonly string[],
  containerName = HERMES_CONTAINER_NAME,
): CloudRunServiceInput => {
  const containers = service.template?.containers;
  return {
    ...service,
    template: {
      ...service.template,
      ...(containers
        ? {
            containers: containers.map((container) =>
              container.name === containerName
                ? {
                    ...container,
                    env: removeCloudRunEnvironment(container.env, names),
                  }
                : container,
            ),
          }
        : {}),
    },
  };
};

const withCloudRunServiceAccount = (
  service: CloudRunServiceInput,
  serviceAccount: string,
): CloudRunServiceInput => ({
  ...service,
  template: {
    ...service.template,
    serviceAccount,
  },
});

export const desiredCloudRunService = (
  spec: CloudRunServiceSpec,
): CloudRunServiceInput => {
  const serviceName = gcpServiceResourceName({
    projectId: spec.projectId,
    region: spec.region,
    serviceName: hermesName(spec.identity),
  });

  const service: CloudRunServiceInput = {
    name: serviceName,
    labels: ownershipMetadata(GCP_OWNERSHIP_SCOPE, spec.identity),
    ingress: GoogleCloudRunV2ServiceIngress.INGRESS_TRAFFIC_ALL,
    invokerIamDisabled: true,
    template: {
      containers: [
        {
          name: HERMES_CONTAINER_NAME,
          image: UNIVERSAL_HERMES_IMAGE,
          ports: [{ containerPort: HERMES_GATEWAY_PORT }],
          volumeMounts: [
            {
              name: HERMES_DATA_VOLUME_NAME,
              mountPath: HERMES_DATA_MOUNT_PATH,
            },
            {
              name: HERMES_NIX_VOLUME_NAME,
              mountPath: HERMES_NIX_MOUNT_PATH,
            },
          ],
        },
      ],
      volumes: [
        {
          name: HERMES_DATA_VOLUME_NAME,
          nfs: {
            server: spec.state.server,
            path: spec.state.dataPath,
          },
        },
        {
          name: HERMES_NIX_VOLUME_NAME,
          nfs: {
            server: spec.state.server,
            path: spec.state.nixPath,
          },
        },
      ],
    },
  };

  return spec.serviceAccount
    ? withCloudRunServiceAccount(service, spec.serviceAccount)
    : service;
};

export const findCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
): Effect.Effect<GoogleCloudRunV2Service | undefined, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.find";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsServicesGet(gcpServiceResourceName(ref), options),
    );

    if (response.status === 200) {
      const success = yield* validateGcpResponseData(
        operation,
        response,
        runProjectsLocationsServicesGet200Response,
      );
      return success.data;
    }
    if (response.status === 404) {
      return undefined;
    }
    return yield* failHttpResponse(operation, response);
  });

const listCloudRunServices = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  params?: RunProjectsLocationsServicesListParams,
): Effect.Effect<runProjectsLocationsServicesListResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.list";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsServicesList(gcpLocationName(ref), params, options),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsServicesList200Response,
    );
  });

const collectCloudRunServicePages = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  params: RunProjectsLocationsServicesListParams | undefined,
  services: readonly GoogleCloudRunV2Service[],
  pageToken: string | undefined,
): Effect.Effect<readonly GoogleCloudRunV2Service[], CloudError> => {
  if (!pageToken) {
    return Effect.succeed(services);
  }

  return Effect.gen(function* () {
    const nextParams: RunProjectsLocationsServicesListParams = {
      ...(params ?? {}),
      pageToken,
    };
    const next = yield* listCloudRunServices(auth, ref, nextParams);
    return yield* collectCloudRunServicePages(
      auth,
      ref,
      params,
      [...services, ...(next.data.services ?? [])],
      next.data.nextPageToken,
    );
  });
};

export const listAllCloudRunServices = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  params?: RunProjectsLocationsServicesListParams,
): Effect.Effect<readonly GoogleCloudRunV2Service[], CloudError> =>
  Effect.gen(function* () {
    const first = yield* listCloudRunServices(auth, ref, params);
    return yield* collectCloudRunServicePages(
      auth,
      ref,
      params,
      first.data.services ?? [],
      first.data.nextPageToken,
    );
  });

export const createCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  service: CloudRunServiceInput,
  params?: RunProjectsLocationsServicesCreateParams,
): Effect.Effect<
  runProjectsLocationsServicesCreateResponseSuccess,
  CloudError
> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.create";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsServicesCreate(
        gcpLocationName(ref),
        service,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsServicesCreate200Response,
    );
  });

export const patchCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
  service: CloudRunServiceInput,
  params?: RunProjectsLocationsServicesPatchParams,
): Effect.Effect<
  runProjectsLocationsServicesPatchResponseSuccess,
  CloudError
> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.patch";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsServicesPatch(
        gcpServiceResourceName(ref),
        service,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsServicesPatch200Response,
    );
  });

export const deleteCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
  params?: RunProjectsLocationsServicesDeleteParams,
): Effect.Effect<
  runProjectsLocationsServicesDeleteResponseSuccess,
  CloudError
> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.delete";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsServicesDelete(
        gcpServiceResourceName(ref),
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsServicesDelete200Response,
    );
  });

export const waitCloudRunOperation = (
  auth: GcpAuthContext,
  ref: GcpOperationRef,
  request: GoogleLongrunningWaitOperationRequest = {},
): Effect.Effect<
  runProjectsLocationsOperationsWaitResponseSuccess,
  CloudError
> =>
  Effect.gen(function* () {
    const operation = "gcp.run.operations.wait";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsOperationsWait(ref.name, request, options),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsOperationsWait200Response,
    );
  });
