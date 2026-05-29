import { Effect } from "effect";

import {
  HERMES_CONTAINER_NAME,
  HERMES_DATA_MOUNT_PATH,
  HERMES_DATA_VOLUME_NAME,
  HERMES_HOME_MANAGER_WRITE_COMMAND,
  OperationFailed,
  ResourceConflict,
  emitCloudEvent,
  type CloudError,
  type HomeManagerModule,
} from "@cardelli/shared";

import { type GcpAuthContext } from "./client.js";
import { waitForCloudRunMutation } from "./cloud-run-operations.js";
import {
  createCloudRunJob,
  findCloudRunJob,
  gcpJobResourceName,
  patchCloudRunJob,
  runCloudRunJob,
  type CloudRunJobInput,
  type GcpJobRef,
} from "./cloud-run-jobs.js";
import { findCloudRunService } from "./cloud-run.js";
import {
  gcpHomeManagerJobRef,
  gcpLabels,
  gcpServiceRef,
  isGcpDeploymentJob,
  isGcpDeploymentService,
  makeGcpDriver,
  validateGcpNfsState,
} from "./deployment.js";
import type { GcpDeployment, GcpStatus } from "./deployment-types.js";
import type { GoogleCloudRunV2Job } from "./generated/run-jobs/model/googleCloudRunV2Job";
import type { GoogleCloudRunV2EnvVar } from "./generated/run-jobs/model/googleCloudRunV2EnvVar";
import type { GoogleCloudRunV2Service } from "./generated/run/model/googleCloudRunV2Service";

type GcpHomeManagerUpdate = {
  readonly identity: GcpDeployment;
  readonly user: string;
  readonly module: HomeManagerModule;
};

const utf8Base64Encode = (value: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const serviceImage = (
  service: GoogleCloudRunV2Service,
): Effect.Effect<string, OperationFailed> => {
  const image = service.template?.containers?.find(
    (container) => container.name === HERMES_CONTAINER_NAME,
  )?.image;

  return image
    ? Effect.succeed(image)
    : Effect.fail(
        new OperationFailed({
          operation: "gcp.home-manager.image",
          message:
            "Could not identify the deployed Hermes container image for the Home Manager module job.",
        }),
      );
};

const homeManagerJobEnv = (
  user: string,
  module: HomeManagerModule,
): readonly GoogleCloudRunV2EnvVar[] => [
  { name: "HERMES_AMBIT_USER", value: user },
  {
    name: "HERMES_AMBIT_MANAGED_MODULE_B64",
    value: utf8Base64Encode(module),
  },
];

const desiredHomeManagerJob = (
  update: GcpHomeManagerUpdate,
  service: GoogleCloudRunV2Service,
  image: string,
): CloudRunJobInput => ({
  name: gcpJobResourceName(gcpHomeManagerJobRef(update.identity)),
  labels: gcpLabels(update.identity),
  template: {
    taskCount: 1,
    template: {
      maxRetries: 0,
      timeout: "300s",
      ...(service.template?.serviceAccount
        ? { serviceAccount: service.template.serviceAccount }
        : {}),
      ...(service.template?.vpcAccess
        ? { vpcAccess: service.template.vpcAccess }
        : {}),
      containers: [
        {
          name: HERMES_CONTAINER_NAME,
          image,
          command: [HERMES_HOME_MANAGER_WRITE_COMMAND],
          volumeMounts: [
            {
              name: HERMES_DATA_VOLUME_NAME,
              mountPath: HERMES_DATA_MOUNT_PATH,
            },
          ],
        },
      ],
      volumes: [
        {
          name: HERMES_DATA_VOLUME_NAME,
          nfs: {
            server: update.identity.state.server,
            path: update.identity.state.dataPath,
          },
        },
      ],
    },
  },
});

const assertOwnedJob = (
  expected: GcpDeployment,
  job: GoogleCloudRunV2Job | undefined,
): Effect.Effect<void, ResourceConflict> => {
  if (!job) {
    return Effect.void;
  }

  if (!isGcpDeploymentJob(expected, job)) {
    return Effect.fail(
      new ResourceConflict({
        resource:
          job.name ?? gcpJobResourceName(gcpHomeManagerJobRef(expected)),
        message: "Cloud Run job name is already used by another deployment",
      }),
    );
  }

  return Effect.void;
};

const requireDeploymentService = (
  auth: GcpAuthContext,
  identity: GcpDeployment,
): Effect.Effect<GoogleCloudRunV2Service, CloudError> =>
  Effect.gen(function* () {
    const service = yield* findCloudRunService(auth, gcpServiceRef(identity));
    if (!service) {
      return yield* Effect.fail(
        new OperationFailed({
          operation: "gcp.home-manager.service",
          message:
            "Cloud Run service must be deployed before config can be updated.",
        }),
      );
    }
    if (!isGcpDeploymentService(identity, service)) {
      return yield* Effect.fail(
        new ResourceConflict({
          resource: service.name ?? gcpServiceRef(identity).serviceName,
          message:
            "Cloud Run service name is already used by another deployment",
        }),
      );
    }
    return service;
  });

const ensureHomeManagerJob = (
  auth: GcpAuthContext,
  update: GcpHomeManagerUpdate,
  service: GoogleCloudRunV2Service,
): Effect.Effect<GcpJobRef, CloudError> =>
  Effect.gen(function* () {
    const ref = gcpHomeManagerJobRef(update.identity);
    const image = yield* serviceImage(service);
    const job = desiredHomeManagerJob(update, service, image);
    const existing = yield* findCloudRunJob(auth, ref);
    yield* assertOwnedJob(update.identity, existing);

    const mutation = existing
      ? yield* patchCloudRunJob(auth, ref, job)
      : yield* createCloudRunJob(auth, update.identity, job, {
          jobId: ref.jobName,
        });

    yield* waitForCloudRunMutation(
      auth,
      "gcp.run.jobs.home-manager.ensure",
      mutation.data,
    );
    return ref;
  });

export const updateGcpHomeManager = (
  auth: GcpAuthContext,
  update: GcpHomeManagerUpdate,
): Effect.Effect<GcpStatus, CloudError> =>
  Effect.gen(function* () {
    yield* validateGcpNfsState("gcp.home-manager.state", update.identity.state);
    yield* emitCloudEvent({
      level: "info",
      scope: "config",
      operation: "home-manager.update",
      resource: update.identity.name,
      message: `Updating Home Manager config for ${update.user}`,
    });
    const service = yield* requireDeploymentService(auth, update.identity);
    const jobRef = yield* ensureHomeManagerJob(auth, update, service);
    const run = yield* runCloudRunJob(auth, jobRef, {
      overrides: {
        containerOverrides: [
          {
            name: HERMES_CONTAINER_NAME,
            env: [...homeManagerJobEnv(update.user, update.module)],
          },
        ],
      },
    });

    yield* waitForCloudRunMutation(
      auth,
      "gcp.run.jobs.home-manager.run",
      run.data,
    );
    yield* emitCloudEvent({
      level: "info",
      scope: "deployment",
      operation: "restart",
      resource: update.identity.name,
      message: "Restarting deployment after config update",
    });
    return yield* makeGcpDriver(auth).restart(update.identity);
  });
