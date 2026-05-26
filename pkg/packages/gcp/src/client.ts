import { Effect } from "effect";

import {
  sendAuthorizedHttp,
  type AuthorizedRequest,
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
): Effect.Effect<AuthorizedRequest, CloudError> =>
  Effect.map(auth.token(), (token) => {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    headers.set("Accept", "application/json");
    if (auth.quotaProjectId) {
      headers.set("x-goog-user-project", auth.quotaProjectId);
    }

    return {
      options: { headers },
    };
  });

export const sendGcp = <A extends HttpResponse>(
  auth: GcpAuthContext,
  operation: string,
  request: (authorized: AuthorizedRequest) => Promise<A>,
): Effect.Effect<A, CloudError> =>
  sendAuthorizedHttp(operation, request, authorizedGcpRequest(auth));
