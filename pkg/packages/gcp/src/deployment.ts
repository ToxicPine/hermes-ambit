import { Effect } from "effect";

import {
  OperationFailed,
  ResourceConflict,
  hermesName,
  ownershipMetadata,
  type CloudError,
  type DeploymentDriver,
  type DeploymentIdentity,
} from "@cardelli/shared";

import type { GoogleCloudRunV2Service } from "./generated/run/model/googleCloudRunV2Service";
import type { GoogleLongrunningOperation } from "./generated/run/model/googleLongrunningOperation";
import type { GoogleRpcStatus } from "./generated/run/model/googleRpcStatus";
import type { GcpAuthContext } from "./client.js";
import {
  createCloudRunService,
  deleteCloudRunService,
  desiredCloudRunService,
  findCloudRunService,
  gcpServiceResourceName,
  patchCloudRunService,
  waitCloudRunOperation,
  type CloudRunServiceInput,
  type GcpNfsState,
  type GcpServiceRef,
} from "./cloud-run.js";

export type GcpDeployment = DeploymentIdentity & {
  readonly projectId: string;
  readonly region: string;
  readonly state: GcpNfsState;
};

export type GcpBoundary = {
  readonly projectId: string;
  readonly region: string;
};

export type GcpPlan = {
  readonly boundary: GcpBoundary;
  readonly serviceRef: GcpServiceRef;
  readonly service: CloudRunServiceInput;
  readonly existingService?: GoogleCloudRunV2Service;
};

export type GcpStatus = {
  readonly service?: GoogleCloudRunV2Service;
};

export type GcpOperations = DeploymentDriver<GcpDeployment, GcpPlan, GcpStatus>;

export const gcpBaseName = hermesName;

export const gcpLabels = (identity: GcpDeployment) =>
  ownershipMetadata("gcp", identity);

export const gcpServiceRef = (identity: GcpDeployment): GcpServiceRef => ({
  projectId: identity.projectId,
  region: identity.region,
  serviceName: hermesName(identity),
});

const statusFromService = (service: GoogleCloudRunV2Service | undefined): GcpStatus =>
  service ? { service } : {};

const assertOwnedService = (
  expected: GcpDeployment,
  service: GoogleCloudRunV2Service | undefined,
): Effect.Effect<void, ResourceConflict> => {
  if (!service) {
    return Effect.void;
  }

  const expectedLabels = gcpLabels(expected);
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (service.labels?.[key] !== value) {
      return Effect.fail(
        new ResourceConflict({
          resource: service.name ?? gcpServiceResourceName(gcpServiceRef(expected)),
          message: "Cloud Run service name is already used by another deployment",
        }),
      );
    }
  }

  return Effect.void;
};

const operationFailed = (
  operation: string,
  message: string,
  cause?: unknown,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    cause === undefined
      ? new OperationFailed({ operation, message })
      : new OperationFailed({ operation, message, cause }),
  );

const rpcStatusMessage = (status: GoogleRpcStatus) =>
  status.message && status.message.length > 0
    ? status.message
    : "Cloud Run operation failed";

const failCompletedOperation = (
  operation: string,
  status: GoogleRpcStatus,
) => operationFailed(operation, rpcStatusMessage(status), status);

const waitForCloudRunOperation = (
  auth: GcpAuthContext,
  ref: { readonly name: string },
  remainingAttempts = 30,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const waited = yield* waitCloudRunOperation(auth, ref, { timeout: "30s" });

    if (waited.data.error) {
      return yield* failCompletedOperation("gcp.run.operations.wait", waited.data.error);
    }
    if (waited.data.done === false) {
      if (remainingAttempts <= 0) {
        return yield* operationFailed(
          "gcp.run.operations.wait",
          `Timed out waiting for ${ref.name}`,
        );
      }
      yield* Effect.sleep("2 seconds");
      return yield* waitForCloudRunOperation(auth, ref, remainingAttempts - 1);
    }
  });

const waitForCloudRunMutation = (
  auth: GcpAuthContext,
  operation: string,
  mutation: GoogleLongrunningOperation,
) =>
  Effect.gen(function* () {
    if (mutation.error) {
      return yield* failCompletedOperation(operation, mutation.error);
    }
    if (mutation.done === true) {
      return;
    }
    if (!mutation.name) {
      return yield* operationFailed(
        operation,
        "Cloud Run mutation did not return an operation name",
        mutation,
      );
    }
    yield* waitForCloudRunOperation(auth, { name: mutation.name });
  });

export const makeGcpDriver = (auth: GcpAuthContext): GcpOperations => {
  const plan = (identity: GcpDeployment): Effect.Effect<GcpPlan, CloudError> =>
    Effect.gen(function* () {
      const serviceRef = gcpServiceRef(identity);
      const existingService = yield* findCloudRunService(auth, serviceRef);
      yield* assertOwnedService(identity, existingService);
      const base = {
        boundary: {
          projectId: identity.projectId,
          region: identity.region,
        },
        serviceRef,
        service: desiredCloudRunService({
          identity,
          projectId: identity.projectId,
          region: identity.region,
          state: identity.state,
        }),
      };

      return existingService ? { ...base, existingService } : base;
    });

  const status = (identity: GcpDeployment) =>
    Effect.gen(function* () {
      const service = yield* findCloudRunService(auth, gcpServiceRef(identity));
      yield* assertOwnedService(identity, service);
      return statusFromService(service);
    });

  const apply = (planned: GcpPlan) =>
    Effect.gen(function* () {
      const mutation = planned.existingService
        ? yield* patchCloudRunService(auth, planned.serviceRef, planned.service, {
            updateMask: "labels,template",
          })
        : yield* createCloudRunService(auth, planned.serviceRef, planned.service, {
            serviceId: planned.serviceRef.serviceName,
          });

      yield* waitForCloudRunMutation(auth, "gcp.run.services.apply", mutation.data);
      const service = yield* findCloudRunService(auth, planned.serviceRef);
      return statusFromService(service);
    });

  const restart = (identity: GcpDeployment) =>
    Effect.gen(function* () {
      const planned = yield* plan(identity);
      if (!planned.existingService) {
        return statusFromService(undefined);
      }

      const mutation = yield* patchCloudRunService(auth, planned.serviceRef, planned.service, {
        forceNewRevision: true,
        updateMask: "template",
      });

      yield* waitForCloudRunMutation(auth, "gcp.run.services.restart", mutation.data);
      const service = yield* findCloudRunService(auth, planned.serviceRef);
      return statusFromService(service);
    });

  const destroy = (identity: GcpDeployment) =>
    Effect.gen(function* () {
      const ref = gcpServiceRef(identity);
      const service = yield* findCloudRunService(auth, ref);
      yield* assertOwnedService(identity, service);
      if (!service) {
        return statusFromService(undefined);
      }

      const mutation = yield* deleteCloudRunService(auth, ref);
      yield* waitForCloudRunMutation(auth, "gcp.run.services.delete", mutation.data);
      return statusFromService(undefined);
    });

  return {
    plan,
    apply,
    status,
    restart,
    destroy,
  };
};
