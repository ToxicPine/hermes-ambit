import { Effect } from "effect";

import {
  HERMES_CONTAINER_NAME,
  OWNERSHIP_SCOPE_KEY,
  OperationFailed,
  RemediationRequired,
  ResourceConflict,
  hermesName,
  isRuntimeSecretName,
  isUniversalHermesImageConfigured,
  ownershipMetadata,
  validateHermesDeploymentIdentity,
  type CloudError,
  type DeploymentDriver,
  type DeploymentIdentity,
} from "@cardelli/shared";

import type { GoogleCloudRunV2Service } from "./generated/run/model/googleCloudRunV2Service";
import type { GoogleCloudRunV2Job } from "./generated/run-jobs/model/googleCloudRunV2Job";
import type { GcpAuthContext } from "./client.js";
import { GCP_OWNERSHIP_SCOPE } from "./constants.js";
import type {
  GcpBoundary,
  GcpDiscoveredDeployment,
  GcpDeployment,
  GcpDeploymentRef,
  GcpNfsState,
  GcpStatus,
} from "./deployment-types.js";
import {
  createCloudRunService,
  deleteCloudRunService,
  cloudRunServiceMatchesInput,
  desiredCloudRunService,
  findCloudRunService,
  gcpServiceResourceName,
  listAllCloudRunServices,
  mergeCloudRunServiceInput,
  patchCloudRunService,
  withCloudRunSecretEnvironment,
  withoutCloudRunEnvironment,
  type CloudRunServiceInput,
  type CloudRunSecretEnvironmentVariable,
  type GcpServiceRef,
} from "./cloud-run.js";
import {
  deleteCloudRunJob,
  findCloudRunJob,
  gcpJobResourceName,
  type GcpJobRef,
} from "./cloud-run-jobs.js";
import { waitForCloudRunMutation } from "./cloud-run-operations.js";
import type { RunProjectsLocationsServicesListParams } from "./generated/run/model/runProjectsLocationsServicesListParams";
import {
  deleteSecret,
  gcpSecretIdForRuntimeName,
  grantSecretAccessorToServiceAccount,
} from "./secret-manager.js";

export type {
  GcpBoundary,
  GcpDiscoveredDeployment,
  GcpDeployment,
  GcpDeploymentRef,
  GcpNfsState,
  GcpStatus,
} from "./deployment-types.js";

type GcpPlanBase = {
  readonly boundary: GcpBoundary;
  readonly serviceRef: GcpServiceRef;
  readonly state: GcpNfsState;
};

type GcpCreatePlan = GcpPlanBase & {
  readonly action: "create";
  readonly service: CloudRunServiceInput;
};

type GcpReadyPlan = GcpPlanBase & {
  readonly action: "ready";
  readonly existingService: GoogleCloudRunV2Service;
};

type GcpUpdatePlan = GcpPlanBase & {
  readonly action: "update";
  readonly service: CloudRunServiceInput;
  readonly existingService: GoogleCloudRunV2Service;
};

export type GcpPlan = GcpCreatePlan | GcpReadyPlan | GcpUpdatePlan;

type GcpOperations = DeploymentDriver<
  GcpDeployment,
  GcpPlan,
  GcpStatus,
  GcpDeploymentRef
>;

export const gcpLabels = (identity: DeploymentIdentity) =>
  ownershipMetadata(GCP_OWNERSHIP_SCOPE, identity);

export const gcpServiceRef = (identity: GcpDeploymentRef): GcpServiceRef => ({
  projectId: identity.projectId,
  region: identity.region,
  serviceName: hermesName(identity),
});

export const gcpHomeManagerJobRef = (identity: GcpDeploymentRef): GcpJobRef => ({
  projectId: identity.projectId,
  region: identity.region,
  jobName: `hm-${identity.name}`,
});

export const validateGcpNfsState = (
  operation: string,
  state: GcpNfsState,
): Effect.Effect<void, OperationFailed> =>
  state.server.trim().length > 0 &&
  state.dataPath.trim().length > 0 &&
  state.nixPath.trim().length > 0
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation,
          message:
            "GCP deployment state requires non-empty NFS server, data path, and Nix path.",
        }),
      );

const requireUniversalImage = (): Effect.Effect<void, OperationFailed> =>
  isUniversalHermesImageConfigured()
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation: "gcp.deployment.image",
          message:
            "UNIVERSAL_HERMES_IMAGE must be set to the published Hermes Ambit runtime image before deploy can create or update Cloud Run.",
        }),
      );

const gcpRuntimeImage = (
  service: GoogleCloudRunV2Service,
): string | undefined =>
  service.template?.containers?.find(
    (container) => container.name === HERMES_CONTAINER_NAME,
  )?.image;

const gcpResourceId = (resourceName: string | undefined): string | undefined =>
  resourceName?.split("/").at(-1);

const statusFromService = (
  service: GoogleCloudRunV2Service | undefined,
): GcpStatus => {
  if (!service) {
    return { deployed: false };
  }

  const image = gcpRuntimeImage(service);
  return {
    deployed: true,
    ...(service.uri ? { endpoint: service.uri } : {}),
    ...(image ? { image } : {}),
    ...(service.latestReadyRevision
      ? { latestReadyRevision: service.latestReadyRevision }
      : {}),
    ...(service.latestCreatedRevision
      ? { latestCreatedRevision: service.latestCreatedRevision }
      : {}),
    ...(service.reconciling !== undefined
      ? { reconciling: service.reconciling }
      : {}),
  };
};

const discoveredStatusFromService = (
  service: GoogleCloudRunV2Service,
): GcpDiscoveredDeployment => {
  const resourceName = gcpResourceId(service.name);
  const { deployed: _deployed, ...status } = statusFromService(service);
  return {
    ...status,
    ...(resourceName ? { resourceName } : {}),
  };
};

const isGcpOwnedService = (service: GoogleCloudRunV2Service): boolean =>
  service.labels?.[OWNERSHIP_SCOPE_KEY] === GCP_OWNERSHIP_SCOPE;

export const isGcpDeploymentService = (
  identity: DeploymentIdentity,
  service: GoogleCloudRunV2Service,
): boolean => {
  const expectedLabels = gcpLabels(identity);
  return Object.entries(expectedLabels).every(
    ([key, value]) => service.labels?.[key] === value,
  );
};

const assertOwnedService = (
  expected: GcpDeploymentRef,
  service: GoogleCloudRunV2Service | undefined,
): Effect.Effect<void, ResourceConflict> => {
  if (!service) {
    return Effect.void;
  }

  if (!isGcpDeploymentService(expected, service)) {
    return Effect.fail(
      new ResourceConflict({
        resource: service.name ?? gcpServiceResourceName(gcpServiceRef(expected)),
        message: "Cloud Run service name is already used by another deployment",
      }),
    );
  }

  return Effect.void;
};

export const isGcpDeploymentJob = (
  identity: DeploymentIdentity,
  job: GoogleCloudRunV2Job,
): boolean => {
  const expectedLabels = gcpLabels(identity);
  return Object.entries(expectedLabels).every(
    ([key, value]) => job.labels?.[key] === value,
  );
};

const assertOwnedJob = (
  expected: GcpDeploymentRef,
  job: GoogleCloudRunV2Job | undefined,
): Effect.Effect<void, ResourceConflict> => {
  if (!job) {
    return Effect.void;
  }

  if (!isGcpDeploymentJob(expected, job)) {
    return Effect.fail(
      new ResourceConflict({
        resource: job.name ?? gcpJobResourceName(gcpHomeManagerJobRef(expected)),
        message: "Cloud Run job name is already used by another deployment",
      }),
    );
  }

  return Effect.void;
};

const listGcpDeploymentServices = (
  auth: GcpAuthContext,
  boundary: GcpBoundary,
  params?: RunProjectsLocationsServicesListParams,
): Effect.Effect<readonly GoogleCloudRunV2Service[], CloudError> =>
  Effect.map(listAllCloudRunServices(auth, boundary, params), (services) =>
    services.filter(isGcpOwnedService),
  );

export const listGcpDeploymentStatuses = (
  auth: GcpAuthContext,
  boundary: GcpBoundary,
  params?: RunProjectsLocationsServicesListParams,
): Effect.Effect<readonly GcpDiscoveredDeployment[], CloudError> =>
  Effect.map(listGcpDeploymentServices(auth, boundary, params), (services) =>
    services.map(discoveredStatusFromService),
  );

export const requireGcpDeploymentService = (
  auth: GcpAuthContext,
  identity: GcpDeploymentRef,
): Effect.Effect<GoogleCloudRunV2Service, CloudError> =>
  Effect.gen(function* () {
    const service = yield* findCloudRunService(auth, gcpServiceRef(identity));
    yield* assertOwnedService(identity, service);
    if (!service) {
      return yield* Effect.fail(
        new OperationFailed({
          operation: "gcp.run.services.runtimeEnvironment",
          message:
            "Cloud Run service must be deployed before runtime secrets can be wired.",
        }),
      );
    }
    return service;
  });

export const requireGcpRuntimeServiceAccount = (
  service: GoogleCloudRunV2Service,
  operation: string,
): Effect.Effect<string, RemediationRequired> => {
  const serviceAccount = service.template?.serviceAccount;
  return serviceAccount
    ? Effect.succeed(serviceAccount)
    : Effect.fail(
        new RemediationRequired({
          scope: operation,
          message:
            "Cloud Run service must use an explicit service account before runtime secrets can be wired.",
          remediation: {
            type: "url",
            label: "Configure a Cloud Run service account",
            url: "https://cloud.google.com/run/docs/securing/service-identity",
          },
        }),
      );
};

export const requireGcpRuntimeContainer = (
  service: GoogleCloudRunV2Service,
  operation: string,
): Effect.Effect<void, OperationFailed> =>
  service.template?.containers?.some(
    (container) => container.name === HERMES_CONTAINER_NAME,
  ) === true
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation,
          message:
            "Cloud Run service must include the Hermes container before runtime secrets can be wired.",
        }),
      );

export const gcpRuntimeSecretNamesFromService = (
  identity: DeploymentIdentity,
  service: GoogleCloudRunV2Service,
): readonly string[] => {
  const container = service.template?.containers?.find(
    (entry) => entry.name === HERMES_CONTAINER_NAME,
  );
  return (container?.env ?? []).flatMap((variable) =>
    variable.name &&
    variable.valueSource?.secretKeyRef?.secret &&
    isRuntimeSecretName(variable.name) &&
    gcpSecretIdForRuntimeName(identity, variable.name) ===
      variable.valueSource.secretKeyRef.secret
      ? [variable.name]
      : [],
  );
};

export const putGcpServiceSecretEnvironmentForService = (
  auth: GcpAuthContext,
  identity: GcpDeploymentRef,
  service: GoogleCloudRunV2Service,
  serviceAccount: string,
  variables: readonly CloudRunSecretEnvironmentVariable[],
): Effect.Effect<GcpStatus, CloudError> =>
  Effect.gen(function* () {
    const ref = gcpServiceRef(identity);
    yield* requireGcpRuntimeContainer(
      service,
      "gcp.run.services.runtimeEnvironment.put",
    );
    for (const variable of variables) {
      yield* grantSecretAccessorToServiceAccount(
        auth,
        { projectId: identity.projectId, secretId: variable.secret },
        serviceAccount,
      );
    }
    const mutation = yield* patchCloudRunService(
      auth,
      ref,
      withCloudRunSecretEnvironment(service, variables),
      { updateMask: "template", forceNewRevision: true },
    );

    yield* waitForCloudRunMutation(
      auth,
      "gcp.run.services.runtimeEnvironment.put",
      mutation.data,
    );
    return statusFromService(yield* findCloudRunService(auth, ref));
  });

export const deleteGcpServiceEnvironment = (
  auth: GcpAuthContext,
  identity: GcpDeploymentRef,
  names: readonly string[],
): Effect.Effect<GcpStatus, CloudError> =>
  Effect.gen(function* () {
    const ref = gcpServiceRef(identity);
    const service = yield* requireGcpDeploymentService(auth, identity);
    yield* requireGcpRuntimeContainer(
      service,
      "gcp.run.services.runtimeEnvironment.delete",
    );
    const mutation = yield* patchCloudRunService(
      auth,
      ref,
      withoutCloudRunEnvironment(service, names),
      { updateMask: "template", forceNewRevision: true },
    );

    yield* waitForCloudRunMutation(
      auth,
      "gcp.run.services.runtimeEnvironment.delete",
      mutation.data,
    );
    return statusFromService(yield* findCloudRunService(auth, ref));
  });

export const makeGcpDriver = (auth: GcpAuthContext): GcpOperations => {
  const plan = (identity: GcpDeployment): Effect.Effect<GcpPlan, CloudError> =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity("gcp.deployment.plan", identity);
      yield* validateGcpNfsState("gcp.deployment.state", identity.state);
      yield* requireUniversalImage();
      const serviceRef = gcpServiceRef(identity);
      const existingService = yield* findCloudRunService(auth, serviceRef);
      yield* assertOwnedService(identity, existingService);
      const desiredService = desiredCloudRunService({
        identity,
        projectId: identity.projectId,
        region: identity.region,
        state: identity.state,
        ...(identity.serviceAccount
          ? { serviceAccount: identity.serviceAccount }
          : {}),
      });
      const base = {
        boundary: {
          projectId: identity.projectId,
          region: identity.region,
        },
        serviceRef,
        state: identity.state,
      };

      if (!existingService) {
        return { ...base, action: "create", service: desiredService };
      }

      const service = mergeCloudRunServiceInput(desiredService, existingService);
      return cloudRunServiceMatchesInput(existingService, desiredService)
        ? { ...base, action: "ready", existingService }
        : { ...base, action: "update", service, existingService };
    });

  const status = (identity: GcpDeploymentRef) =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity("gcp.deployment.status", identity);
      const service = yield* findCloudRunService(auth, gcpServiceRef(identity));
      yield* assertOwnedService(identity, service);
      return statusFromService(service);
    });

  const apply = (planned: GcpPlan) =>
    Effect.gen(function* () {
      if (planned.action === "ready") {
        return statusFromService(planned.existingService);
      }

      const mutation = planned.action === "update"
        ? yield* patchCloudRunService(auth, planned.serviceRef, planned.service, {
            updateMask: "labels,ingress,invokerIamDisabled,template",
          })
        : yield* createCloudRunService(auth, planned.serviceRef, planned.service, {
            serviceId: planned.serviceRef.serviceName,
          });

      yield* waitForCloudRunMutation(auth, "gcp.run.services.apply", mutation.data);
      const service = yield* findCloudRunService(auth, planned.serviceRef);
      return statusFromService(service);
    });

  const restart = (identity: GcpDeploymentRef) =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity("gcp.deployment.restart", identity);
      const ref = gcpServiceRef(identity);
      const service = yield* findCloudRunService(auth, ref);
      yield* assertOwnedService(identity, service);
      if (!service) {
        return yield* Effect.fail(
          new OperationFailed({
            operation: "gcp.run.services.restart",
            message: "Cloud Run service must be deployed before it can be restarted.",
          }),
        );
      }

      const mutation = yield* patchCloudRunService(
        auth,
        ref,
        {
          ...(service.name ? { name: service.name } : {}),
          ...(service.template ? { template: service.template } : {}),
        },
        {
          forceNewRevision: true,
          updateMask: "template",
        },
      );

      yield* waitForCloudRunMutation(auth, "gcp.run.services.restart", mutation.data);
      const restarted = yield* findCloudRunService(auth, ref);
      return statusFromService(restarted);
    });

  const destroy = (identity: GcpDeploymentRef) =>
    Effect.gen(function* () {
      yield* validateHermesDeploymentIdentity("gcp.deployment.destroy", identity);
      const ref = gcpServiceRef(identity);
      const jobRef = gcpHomeManagerJobRef(identity);
      const service = yield* findCloudRunService(auth, ref);
      const job = yield* findCloudRunJob(auth, jobRef);
      yield* assertOwnedService(identity, service);
      yield* assertOwnedJob(identity, job);
      const runtimeSecretNames = service
        ? gcpRuntimeSecretNamesFromService(identity, service)
        : [];
      if (!service && !job) {
        return statusFromService(undefined);
      }

      if (job) {
        const mutation = yield* deleteCloudRunJob(auth, jobRef);
        yield* waitForCloudRunMutation(
          auth,
          "gcp.run.jobs.home-manager.delete",
          mutation.data,
        );
      }
      if (service) {
        const mutation = yield* deleteCloudRunService(auth, ref);
        yield* waitForCloudRunMutation(auth, "gcp.run.services.delete", mutation.data);
      }
      for (const runtimeName of runtimeSecretNames) {
        yield* deleteSecret(auth, {
          projectId: identity.projectId,
          secretId: gcpSecretIdForRuntimeName(identity, runtimeName),
          owner: identity,
        });
      }
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
