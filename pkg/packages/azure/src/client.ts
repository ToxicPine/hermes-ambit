import { Effect } from "effect";
import type { z } from "zod";

import {
  OperationFailed,
  emitCloudEvent,
  failHttpResponse,
  invokeJsonHttp,
  sendAuthorizedHttp,
  type CloudError,
  type HttpResponse,
} from "@cardelli/shared";
import type { OperationStatusResult } from "./generated/container-apps/model/common-types-resource-management-v5-types/operationStatusResult";

export type AzureAccessToken = {
  readonly accessToken: string;
  readonly expiresAtEpochSeconds: number;
  readonly subscriptionId: string;
  readonly tenantId: string;
};

export type AzureAuthContext = {
  readonly token: () => Effect.Effect<AzureAccessToken, CloudError>;
};

export const authorizedAzureRequest = (
  auth: AzureAuthContext,
): Effect.Effect<RequestInit, CloudError> =>
  Effect.map(auth.token(), (token) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: "application/json",
    };

    return { headers };
  });

export const sendAzure = <A extends HttpResponse>(
  auth: AzureAuthContext,
  operation: string,
  request: (authorized: RequestInit) => Promise<A>,
): Effect.Effect<A, CloudError> =>
  sendAuthorizedHttp(operation, request, authorizedAzureRequest(auth));

export const validateAzureResponseData = <
  TData,
  TResponse extends { readonly data: unknown },
>(
  operation: string,
  response: TResponse,
  schema: z.ZodType<TData>,
): Effect.Effect<TResponse & { readonly data: TData }, CloudError> => {
  const parsed = schema.safeParse(response.data);
  return parsed.success
    ? Effect.succeed({ ...response, data: parsed.data })
    : Effect.fail(
        new OperationFailed({
          operation,
          message: `${operation} response failed validation`,
          cause: parsed.error,
        }),
      );
};

type AzureAsyncOperation = {
  readonly kind: "azureAsyncOperation";
  readonly url: string;
};

type AzureLocationOperation = {
  readonly kind: "location";
  readonly url: string;
};

type AzureOperationPollRef = AzureAsyncOperation | AzureLocationOperation;

const azureOperationPollRef = (
  response: { readonly headers: Headers },
): AzureOperationPollRef | undefined => {
  const azureAsyncUrl =
    response.headers.get("Azure-AsyncOperation") ??
    response.headers.get("Operation-Location");
  if (azureAsyncUrl) {
    return {
      kind: "azureAsyncOperation",
      url: azureAsyncUrl,
    };
  }

  const locationUrl = response.headers.get("Location");
  return locationUrl
    ? {
        kind: "location",
        url: locationUrl,
      }
    : undefined;
};

const azureOperationStatus = (
  data: unknown,
): OperationStatusResult["status"] | undefined => {
  if (data !== null && typeof data === "object" && "status" in data) {
    const status = data.status;
    return typeof status === "string" ? status : undefined;
  }
  return undefined;
};

const failAzureOperation = (
  operation: string,
  message: string,
  cause?: unknown,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    cause === undefined
      ? new OperationFailed({ operation, message })
      : new OperationFailed({ operation, message, cause }),
  );

const pollAzureAsyncOperation = (
  auth: AzureAuthContext,
  operation: string,
  ref: AzureAsyncOperation,
  remainingAttempts: number,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const pollOperation = `${operation}.poll`;
    const authorized = yield* authorizedAzureRequest(auth);
    const response = yield* invokeJsonHttp(pollOperation, () =>
      fetch(ref.url, {
        ...authorized,
        method: "GET",
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* failHttpResponse(pollOperation, response);
    }

    const status = azureOperationStatus(response.data);

    if (status === "Succeeded") {
      return;
    }
    if (status === "Failed" || status === "Canceled" || status === "Cancelled") {
      return yield* failAzureOperation(
        pollOperation,
        `Azure operation ${status}`,
        response.data,
      );
    }
    if (!status) {
      return yield* failAzureOperation(
        pollOperation,
        "Azure operation response did not include a status",
        response.data,
      );
    }
    if (remainingAttempts <= 0) {
      return yield* failAzureOperation(
        pollOperation,
        `Timed out waiting for Azure operation ${ref.url}`,
      );
    }

    yield* Effect.sleep("2 seconds");
    return yield* pollAzureAsyncOperation(
      auth,
      operation,
      ref,
      remainingAttempts - 1,
    );
  });

const pollAzureLocationOperation = (
  auth: AzureAuthContext,
  operation: string,
  ref: AzureLocationOperation,
  remainingAttempts: number,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const pollOperation = `${operation}.poll`;
    const authorized = yield* authorizedAzureRequest(auth);
    const response = yield* invokeJsonHttp(pollOperation, () =>
      fetch(ref.url, {
        ...authorized,
        method: "GET",
      }),
    );

    if (response.status !== 202) {
      if (response.status < 200 || response.status >= 300) {
        return yield* failHttpResponse(pollOperation, response);
      }
      return;
    }
    if (remainingAttempts <= 0) {
      return yield* failAzureOperation(
        pollOperation,
        `Timed out waiting for Azure operation ${ref.url}`,
      );
    }

    yield* Effect.sleep("2 seconds");
    return yield* pollAzureLocationOperation(
      auth,
      operation,
      ref,
      remainingAttempts - 1,
    );
  });

export const waitAzureLongRunningOperation = (
  auth: AzureAuthContext,
  operation: string,
  response: { readonly headers: Headers },
  remainingAttempts = 60,
): Effect.Effect<void, CloudError> => {
  const ref = azureOperationPollRef(response);
  if (!ref) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    yield* emitCloudEvent({
      level: "info",
      scope: "provider",
      operation,
      resource: ref.url,
      message: "Waiting for Azure operation",
    });
    if (ref.kind === "azureAsyncOperation") {
      yield* pollAzureAsyncOperation(auth, operation, ref, remainingAttempts);
    } else {
      yield* pollAzureLocationOperation(auth, operation, ref, remainingAttempts);
    }
    yield* emitCloudEvent({
      level: "info",
      scope: "provider",
      operation,
      resource: ref.url,
      message: "Azure operation completed",
    });
  });
};
