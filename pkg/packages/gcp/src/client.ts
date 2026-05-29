import { Effect } from "effect";
import type { z } from "zod";

import {
  OperationFailed,
  sendAuthorizedHttp,
  type CloudError,
  type HttpResponse,
} from "@cardelli/shared";

export type GcpAccessToken = {
  readonly accessToken: string;
  readonly expiresAtEpochSeconds?: number;
};

export type GcpAuthContext = {
  readonly token: () => Effect.Effect<GcpAccessToken, CloudError>;
  readonly quotaProjectId?: string;
};

export const authorizedGcpRequest = (
  auth: GcpAuthContext,
): Effect.Effect<RequestInit, CloudError> =>
  Effect.map(auth.token(), (token) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: "application/json",
    };
    if (auth.quotaProjectId) {
      headers["x-goog-user-project"] = auth.quotaProjectId;
    }

    return { headers };
  });

export const sendGcp = <A extends HttpResponse>(
  auth: GcpAuthContext,
  operation: string,
  request: (authorized: RequestInit) => Promise<A>,
): Effect.Effect<A, CloudError> =>
  sendAuthorizedHttp(operation, request, authorizedGcpRequest(auth));

export const validateGcpResponseData = <
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
