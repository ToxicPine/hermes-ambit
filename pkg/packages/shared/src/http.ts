import { Effect } from "effect";

import { OperationFailed } from "./errors.js";
import type { CloudError } from "./errors.js";

export type HttpResponse = {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Headers;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object";

const messageField = (
  value: Readonly<Record<string, unknown>>,
): string | undefined => {
  const message = value.message;
  return typeof message === "string" && message.length > 0
    ? message
    : undefined;
};

const httpMessage = (response: HttpResponse) => {
  const data = response.data;
  if (isRecord(data)) {
    const message = messageField(data);
    if (message) return message;

    const nested = data.error;
    if (isRecord(nested)) {
      const nestedMessage = messageField(nested);
      if (nestedMessage) return nestedMessage;
    }
  }
  return `HTTP ${response.status}`;
};

export const invokeHttp = <A>(
  operation: string,
  request: () => Promise<A>,
): Effect.Effect<A, OperationFailed> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new OperationFailed({
        operation,
        message: `${operation} request failed`,
        cause,
      }),
  });

export const invokeJsonHttp = (
  operation: string,
  request: () => Promise<Response>,
): Effect.Effect<HttpResponse, OperationFailed> =>
  Effect.gen(function* () {
    const response = yield* invokeHttp(operation, request);
    const body = [204, 205, 304].includes(response.status)
      ? ""
      : yield* invokeHttp(operation, () => response.text());
    const data =
      body.length === 0
        ? {}
        : yield* invokeHttp(operation, () => Promise.resolve(JSON.parse(body)));

    return {
      status: response.status,
      data,
      headers: response.headers,
    };
  });

const hasHttpStatus = <
  A extends HttpResponse,
  Status extends A["status"] & number,
>(
  response: A,
  statuses: readonly Status[],
): response is Extract<A, { readonly status: Status }> =>
  statuses.some((status) => status === response.status);

export const expectHttpStatus = <
  A extends HttpResponse,
  Status extends A["status"] & number,
>(
  operation: string,
  response: A,
  statuses: readonly Status[],
): Effect.Effect<Extract<A, { readonly status: Status }>, OperationFailed> =>
  hasHttpStatus(response, statuses)
    ? Effect.succeed(response)
    : Effect.fail(
        new OperationFailed({
          operation,
          message: `${httpMessage(response)}; expected ${statuses.join(" or ")}`,
          cause: response.data,
        }),
      );

export const failHttpResponse = (
  operation: string,
  response: HttpResponse,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    new OperationFailed({
      operation,
      message: httpMessage(response),
      cause: response.data,
    }),
  );

export const sendAuthorizedHttp = <A extends HttpResponse>(
  operation: string,
  request: (authorized: RequestInit) => Promise<A>,
  authorized: Effect.Effect<RequestInit, CloudError>,
): Effect.Effect<A, CloudError> =>
  Effect.gen(function* () {
    const requestAuth = yield* authorized;
    return yield* invokeHttp(operation, () => request(requestAuth));
  });
