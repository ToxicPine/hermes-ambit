import { Effect } from "effect";
import type { z } from "zod";

import {
  OperationFailed,
  failHttpResponse,
  invokeJsonHttp,
  type CloudError,
} from "@cardelli/shared";

import { getAzureFoundryOpenAICompatibleModelsListUrl } from "./generated/openai/client";
import { azureFoundryOpenAICompatibleModelsList200Response } from "./generated/openai/client/azureFoundryOpenAICompatibleModelsAPI.zod";

const AZURE_FOUNDRY_OPENAI_COMPATIBLE_MODELS_API_VERSION = "2024-10-21";

export type AzureFoundryOpenAICompatibleAuthContext =
  | {
      readonly kind: "apiKey";
      readonly apiKey: () => Effect.Effect<string, CloudError>;
    }
  | {
      readonly kind: "entraId";
      readonly token: () => Effect.Effect<
        { readonly accessToken: string },
        CloudError
      >;
    };

type AzureFoundryOpenAICompatibleModelsResponse = z.infer<
  typeof azureFoundryOpenAICompatibleModelsList200Response
>;

export type AzureFoundryOpenAICompatibleModels = readonly {
  readonly id: string;
}[];

const AZURE_OPENAI_PATH = "/openai";
const AZURE_OPENAI_V1_PATH = "/openai/v1";

const azureFoundryOpenAICompatibleResourceEndpoint = (endpoint: string) => {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed.endsWith(AZURE_OPENAI_V1_PATH)) {
    return trimmed.slice(0, -AZURE_OPENAI_V1_PATH.length);
  }
  if (trimmed.endsWith(AZURE_OPENAI_PATH)) {
    return trimmed.slice(0, -AZURE_OPENAI_PATH.length);
  }
  return trimmed;
};

const azureFoundryOpenAICompatibleModelsFromResponse = (
  response: AzureFoundryOpenAICompatibleModelsResponse,
): AzureFoundryOpenAICompatibleModels =>
  (response.data ?? []).flatMap((model) =>
    model.id && model.id.length > 0 ? [{ id: model.id }] : [],
  );

export const azureFoundryOpenAICompatibleModelsUrl = (endpoint: string) =>
  `${azureFoundryOpenAICompatibleResourceEndpoint(endpoint)}${getAzureFoundryOpenAICompatibleModelsListUrl(
    {
      "api-version": AZURE_FOUNDRY_OPENAI_COMPATIBLE_MODELS_API_VERSION,
    },
  )}`;

const authorizedAzureFoundryOpenAICompatibleRequest = (
  auth: AzureFoundryOpenAICompatibleAuthContext,
): Effect.Effect<RequestInit, CloudError> =>
  Effect.gen(function* () {
    const headers = new Headers();
    headers.set("Accept", "application/json");

    if (auth.kind === "apiKey") {
      headers.set("api-key", yield* auth.apiKey());
      return { headers };
    }

    const token = yield* auth.token();
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    return { headers };
  });

export const listAzureFoundryOpenAICompatibleModels = (
  auth: AzureFoundryOpenAICompatibleAuthContext,
  endpoint: string,
): Effect.Effect<AzureFoundryOpenAICompatibleModels, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.foundry.openai-compatible.models.list";
    const options = yield* authorizedAzureFoundryOpenAICompatibleRequest(auth);
    const response = yield* invokeJsonHttp(operation, () =>
      fetch(azureFoundryOpenAICompatibleModelsUrl(endpoint), {
        ...options,
        method: "GET",
      }),
    );

    if (response.status !== 200) {
      return yield* failHttpResponse(operation, response);
    }

    const parsed = azureFoundryOpenAICompatibleModelsList200Response.safeParse(
      response.data,
    );
    if (!parsed.success) {
      return yield* Effect.fail(
        new OperationFailed({
          operation,
          message:
            "Azure Foundry OpenAI-compatible models response failed validation",
          cause: parsed.error,
        }),
      );
    }

    return azureFoundryOpenAICompatibleModelsFromResponse(parsed.data);
  });
