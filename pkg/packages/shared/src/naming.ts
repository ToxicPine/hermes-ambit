import { Effect } from "effect";

import { OperationFailed } from "./errors.js";
import type { DeploymentIdentity } from "./model.js";

export const HERMES_DEPLOYMENT_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
export const HERMES_DEPLOYMENT_NAME_MESSAGE = [
  "Deployment names must start with a lowercase letter or number",
  "and contain only lowercase letters, numbers, or dashes, with length <= 41.",
  "They must not end with a dash.",
].join(" ");

export const validateHermesDeploymentName = (
  name: string,
): string | undefined =>
  HERMES_DEPLOYMENT_NAME_PATTERN.test(name)
    ? undefined
    : HERMES_DEPLOYMENT_NAME_MESSAGE;

export const validateHermesDeploymentIdentity = (
  operation: string,
  identity: DeploymentIdentity,
): Effect.Effect<void, OperationFailed> => {
  const message = validateHermesDeploymentName(identity.name);
  return message
    ? Effect.fail(
        new OperationFailed({
          operation,
          message,
        }),
      )
    : Effect.void;
};

export const hermesName = (identity: DeploymentIdentity) =>
  `hermes-${identity.name}`;

export const OWNERSHIP_SCOPE_KEY = "hermes-managed-scope";
export const OWNERSHIP_DEPLOYMENT_KEY = "hermes-managed-deployment";

export const ownershipMetadata = (
  scope: string,
  identity: DeploymentIdentity,
): Readonly<Record<string, string>> => ({
  [OWNERSHIP_SCOPE_KEY]: scope,
  [OWNERSHIP_DEPLOYMENT_KEY]: hermesName(identity),
});
