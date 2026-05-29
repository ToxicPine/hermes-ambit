import { Effect } from "effect";
import type { z } from "zod";

import {
  OperationFailed,
  failHttpResponse,
  invokeJsonHttp,
  type CloudError,
} from "@cardelli/shared";

import { authorizedGcpRequest, type GcpAuthContext } from "./client.js";
import { getAiplatformPublishersModelsListUrl } from "./generated/aiplatform/client";
import { aiplatformPublishersModelsList200Response } from "./generated/aiplatform/client/agentPlatformAPI.zod";
import type { AiplatformPublishersModelsListParams } from "./generated/aiplatform/model/aiplatformPublishersModelsListParams";

const GCP_GOOGLE_PUBLISHER = "google";

type GcpPublisherModelsListParams = AiplatformPublishersModelsListParams;

type GcpPublisherModelsRef = {
  readonly region: string;
  readonly publisher: string;
};

type GcpPublisherModelsResponse = z.infer<
  typeof aiplatformPublishersModelsList200Response
>;

export type GcpPublisherModels = readonly {
  readonly id: string;
  readonly supportsRestApi: boolean;
}[];

const gcpPublisherName = (publisher: string) => `publishers/${publisher}`;

const modelIdFromName = (name: string | undefined): string | undefined => {
  const id = name?.split("/").at(-1);
  return id && id.length > 0 ? id : undefined;
};

const gcpPublisherModelsFromResponse = (
  response: GcpPublisherModelsResponse,
): GcpPublisherModels =>
  (response.publisherModels ?? []).flatMap((model) => {
    const id = modelIdFromName(model.name);
    return id
      ? [
          {
            id,
            supportsRestApi: model.supportedActions?.viewRestApi !== undefined,
          },
        ]
      : [];
  });

const gcpPublisherModelsUrl = (
  ref: GcpPublisherModelsRef,
  params?: GcpPublisherModelsListParams,
) => {
  const url = new URL(
    getAiplatformPublishersModelsListUrl(gcpPublisherName(ref.publisher), params),
  );
  url.hostname = `${ref.region}-aiplatform.googleapis.com`;
  return url.toString();
};

const listGcpPublisherModels = (
  auth: GcpAuthContext,
  ref: GcpPublisherModelsRef,
  params?: GcpPublisherModelsListParams,
): Effect.Effect<GcpPublisherModels, CloudError> =>
  Effect.gen(function* () {
    const operation = "gcp.aiplatform.publishers.models.list";
    const authorized = yield* authorizedGcpRequest(auth);
    const response = yield* invokeJsonHttp(operation, () =>
      fetch(gcpPublisherModelsUrl(ref, params), {
        ...authorized,
        method: "GET",
      }),
    );

    if (response.status !== 200) {
      return yield* failHttpResponse(operation, response);
    }

    const parsed = aiplatformPublishersModelsList200Response.safeParse(
      response.data,
    );
    if (!parsed.success) {
      return yield* Effect.fail(
        new OperationFailed({
          operation,
          message: "GCP publisher models response failed validation",
          cause: parsed.error,
        }),
      );
    }

    return gcpPublisherModelsFromResponse(parsed.data);
  });

export const listGooglePublisherModels = (
  auth: GcpAuthContext,
  region: string,
): Effect.Effect<GcpPublisherModels, CloudError> =>
  listGcpPublisherModels(
    auth,
    { region, publisher: GCP_GOOGLE_PUBLISHER },
    { view: "PUBLISHER_MODEL_VIEW_FULL" },
  );
