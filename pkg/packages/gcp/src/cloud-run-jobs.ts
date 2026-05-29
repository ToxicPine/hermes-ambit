import { Effect } from "effect";

import {
  expectHttpStatus,
  failHttpResponse,
  type CloudError,
} from "@cardelli/shared";

import {
  sendGcp,
  validateGcpResponseData,
  type GcpAuthContext,
} from "./client.js";
import { gcpLocationName, type GcpLocationRef } from "./cloud-run.js";
import {
  runProjectsLocationsJobsCreate,
  runProjectsLocationsJobsDelete,
  runProjectsLocationsJobsGet,
  runProjectsLocationsJobsPatch,
  runProjectsLocationsJobsRun,
  type runProjectsLocationsJobsCreateResponseSuccess,
  type runProjectsLocationsJobsDeleteResponseSuccess,
  type runProjectsLocationsJobsPatchResponseSuccess,
  type runProjectsLocationsJobsRunResponseSuccess,
} from "./generated/run-jobs/client";
import {
  runProjectsLocationsJobsCreate200Response,
  runProjectsLocationsJobsDelete200Response,
  runProjectsLocationsJobsGet200Response,
  runProjectsLocationsJobsPatch200Response,
  runProjectsLocationsJobsRun200Response,
} from "./generated/run-jobs/client/cloudRunAdminAPI.zod";
import type { GoogleCloudRunV2Job } from "./generated/run-jobs/model/googleCloudRunV2Job";
import type { GoogleCloudRunV2RunJobRequest } from "./generated/run-jobs/model/googleCloudRunV2RunJobRequest";
import type { RunProjectsLocationsJobsCreateParams } from "./generated/run-jobs/model/runProjectsLocationsJobsCreateParams";
import type { RunProjectsLocationsJobsDeleteParams } from "./generated/run-jobs/model/runProjectsLocationsJobsDeleteParams";
import type { RunProjectsLocationsJobsPatchParams } from "./generated/run-jobs/model/runProjectsLocationsJobsPatchParams";

export type GcpJobRef = GcpLocationRef & {
  readonly jobName: string;
};

export type CloudRunJobInput = Parameters<
  typeof runProjectsLocationsJobsCreate
>[1];

export const gcpJobResourceName = (ref: GcpJobRef) =>
  `${gcpLocationName(ref)}/jobs/${ref.jobName}`;

export const findCloudRunJob = (
  auth: GcpAuthContext,
  ref: GcpJobRef,
): Effect.Effect<GoogleCloudRunV2Job | undefined, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.jobs.find";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsJobsGet(gcpJobResourceName(ref), options),
    );

    if (response.status === 200) {
      const success = yield* validateGcpResponseData(
        operation,
        response,
        runProjectsLocationsJobsGet200Response,
      );
      return success.data;
    }
    if (response.status === 404) {
      return undefined;
    }
    return yield* failHttpResponse(operation, response);
  });

export const createCloudRunJob = (
  auth: GcpAuthContext,
  ref: GcpLocationRef,
  job: CloudRunJobInput,
  params?: RunProjectsLocationsJobsCreateParams,
): Effect.Effect<runProjectsLocationsJobsCreateResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.jobs.create";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsJobsCreate(
        gcpLocationName(ref),
        job,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsJobsCreate200Response,
    );
  });

export const patchCloudRunJob = (
  auth: GcpAuthContext,
  ref: GcpJobRef,
  job: CloudRunJobInput,
  params?: RunProjectsLocationsJobsPatchParams,
): Effect.Effect<runProjectsLocationsJobsPatchResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.jobs.patch";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsJobsPatch(
        gcpJobResourceName(ref),
        job,
        params,
        options,
      ),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsJobsPatch200Response,
    );
  });

export const deleteCloudRunJob = (
  auth: GcpAuthContext,
  ref: GcpJobRef,
  params?: RunProjectsLocationsJobsDeleteParams,
): Effect.Effect<runProjectsLocationsJobsDeleteResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.jobs.delete";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsJobsDelete(gcpJobResourceName(ref), params, options),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsJobsDelete200Response,
    );
  });

export const runCloudRunJob = (
  auth: GcpAuthContext,
  ref: GcpJobRef,
  request: GoogleCloudRunV2RunJobRequest = {},
): Effect.Effect<runProjectsLocationsJobsRunResponseSuccess, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.run.jobs.run";
    const response = yield* sendGcp(auth, operation, (options) =>
      runProjectsLocationsJobsRun(gcpJobResourceName(ref), request, options),
    );
    const success = yield* expectHttpStatus(operation, response, [200]);
    return yield* validateGcpResponseData(
      operation,
      success,
      runProjectsLocationsJobsRun200Response,
    );
  });
