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
  runProjectsLocationsOperationsWait,
  runProjectsLocationsServicesCreate,
  runProjectsLocationsServicesDelete,
  runProjectsLocationsServicesGet,
  runProjectsLocationsServicesList,
  runProjectsLocationsServicesPatch,
  type runProjectsLocationsOperationsWaitResponseSuccess,
  type runProjectsLocationsServicesCreateResponseSuccess,
  type runProjectsLocationsServicesDeleteResponseSuccess,
  type runProjectsLocationsServicesGetResponseSuccess,
  type runProjectsLocationsServicesListResponseSuccess,
  type runProjectsLocationsServicesPatchResponseSuccess,
} from "./generated/run/client";
import type { GoogleLongrunningWaitOperationRequest } from "./generated/run/model/googleLongrunningWaitOperationRequest";
import type { GoogleCloudRunV2Service } from "./generated/run/model/googleCloudRunV2Service";
import type { RunProjectsLocationsServicesCreateParams } from "./generated/run/model/runProjectsLocationsServicesCreateParams";
import type { RunProjectsLocationsServicesDeleteParams } from "./generated/run/model/runProjectsLocationsServicesDeleteParams";
import type { RunProjectsLocationsServicesListParams } from "./generated/run/model/runProjectsLocationsServicesListParams";
import type { RunProjectsLocationsServicesPatchParams } from "./generated/run/model/runProjectsLocationsServicesPatchParams";
import { sendGcp, type GcpAuthContext } from "./client.js";

export type GcpLocationRef = {
  readonly projectId: string;
  readonly region: string;
};

export type GcpServiceRef = GcpLocationRef & {
  readonly serviceName: string;
};

export type GcpOperationRef = {
  readonly name: string;
};

export type CloudRunServiceInput = Parameters<
  typeof runProjectsLocationsServicesCreate
>[1];

export type GcpNfsState = {
  readonly server: string;
  readonly dataPath: string;
  readonly nixPath: string;
};

export type CloudRunServiceSpec = {
  readonly identity: DeploymentIdentity;
  readonly projectId: string;
  readonly region: string;
  readonly state: GcpNfsState;
};

export const gcpLocationName = (ref: GcpLocationRef) =>
  `projects/${ref.projectId}/locations/${ref.region}`;

export const gcpServiceResourceName = (ref: GcpServiceRef) =>
  `${gcpLocationName(ref)}/services/${ref.serviceName}`;

export const desiredCloudRunService = (
  spec: CloudRunServiceSpec,
): CloudRunServiceInput => {
  const serviceName = gcpServiceResourceName({
    projectId: spec.projectId,
    region: spec.region,
    serviceName: hermesName(spec.identity),
  });

  return {
    name: serviceName,
    labels: ownershipMetadata("gcp", spec.identity),
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
};

export const getCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
): Effect.Effect<runProjectsLocationsServicesGetResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.get";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsServicesGet(gcpServiceResourceName(ref), options),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const findCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
): Effect.Effect<GoogleCloudRunV2Service | undefined, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.find";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsServicesGet(gcpServiceResourceName(ref), options),
    );

    if (response.status === 200) {
      return response.data;
    }
    if (response.status === 404) {
      return undefined;
    }
    return yield* failHttpResponse(operation, response);
  });

export const listCloudRunServices = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  params?: RunProjectsLocationsServicesListParams,
): Effect.Effect<runProjectsLocationsServicesListResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.list";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsServicesList(gcpLocationName(ref), params, options),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const createCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  service: CloudRunServiceInput,
  params?: RunProjectsLocationsServicesCreateParams,
): Effect.Effect<runProjectsLocationsServicesCreateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.create";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsServicesCreate(gcpLocationName(ref), service, params, options),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const patchCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
  service: CloudRunServiceInput,
  params?: RunProjectsLocationsServicesPatchParams,
): Effect.Effect<runProjectsLocationsServicesPatchResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.patch";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsServicesPatch(
        gcpServiceResourceName(ref),
        service,
        params,
        options,
      ),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const deleteCloudRunService = (
  auth: GcpAuthContext,
  ref: GcpServiceRef,
  params?: RunProjectsLocationsServicesDeleteParams,
): Effect.Effect<runProjectsLocationsServicesDeleteResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.services.delete";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsServicesDelete(gcpServiceResourceName(ref), params, options),
    );
    return yield* expectHttpSuccess(operation, response);
  });

export const waitCloudRunOperation = (
  auth: GcpAuthContext,
  ref: GcpOperationRef,
  request: GoogleLongrunningWaitOperationRequest = {},
): Effect.Effect<runProjectsLocationsOperationsWaitResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.operations.wait";
    const response = yield* sendGcp(auth, operation, ({ options }) =>
      runProjectsLocationsOperationsWait(ref.name, request, options),
    );
    return yield* expectHttpSuccess(operation, response);
  });
