import { Effect } from "effect";

import { OperationFailed } from "./errors.js";
import type { CloudError } from "./errors.js";

export type AuthorizedRequest = {
  readonly options: RequestInit;
};

export type HttpResponse = {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Headers;
};

export type HttpSuccessStatus =
  | 200
  | 201
  | 202
  | 203
  | 204
  | 205
  | 206
  | 207;

export type HttpSuccessResponse<A extends HttpResponse> = Extract<
  A,
  { readonly status: HttpSuccessStatus }
>;

const isHttpSuccessResponse = <A extends HttpResponse>(
  response: A,
): response is HttpSuccessResponse<A> =>
  response.status >= 200 && response.status < 300;

const httpMessage = (response: HttpResponse) => {
  const data = response.data;
  if (data && typeof data === "object" && "message" in data) {
    const message = data.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
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

export const expectHttpSuccess = <A extends HttpResponse>(
  operation: string,
  response: A,
): Effect.Effect<HttpSuccessResponse<A>, OperationFailed> =>
  isHttpSuccessResponse(response)
    ? Effect.succeed(response)
    : failHttpResponse(operation, response);

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
  request: (authorized: AuthorizedRequest) => Promise<A>,
  authorized: Effect.Effect<AuthorizedRequest, CloudError>,
): Effect.Effect<A, CloudError> =>
  Effect.gen(function* () {
    const requestAuth = yield* authorized;
    return yield* invokeHttp(operation, () => request(requestAuth));
  });
