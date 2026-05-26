import { Effect } from "effect";

import {
  sendAuthorizedHttp,
  type AuthorizedRequest,
  type CloudError,
  type HttpResponse,
} from "@cardelli/shared";

export type AzureAccessToken = {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresAtEpochSeconds: number;
  readonly subscriptionId: string;
  readonly tenantId: string;
};

export type AzureAuthContext = {
  readonly token: () => Effect.Effect<AzureAccessToken, CloudError>;
};

export const authorizedAzureRequest = (
  auth: AzureAuthContext,
): Effect.Effect<AuthorizedRequest, CloudError> =>
  Effect.map(auth.token(), (token) => {
    const headers = new Headers();
    headers.set("Authorization", `${token.tokenType} ${token.accessToken}`);
    headers.set("Accept", "application/json");

    return {
      options: { headers },
    };
  });

export const sendAzure = <A extends HttpResponse>(
  auth: AzureAuthContext,
  operation: string,
  request: (authorized: AuthorizedRequest) => Promise<A>,
): Effect.Effect<A, CloudError> =>
  sendAuthorizedHttp(operation, request, authorizedAzureRequest(auth));
