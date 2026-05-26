import type { DeploymentIdentity } from "./model.js";

const compact = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");

export const hermesName = (identity: DeploymentIdentity) =>
  compact(`hermes-${identity.name}`).slice(0, 48);

export const ownershipMetadata = (
  scope: string,
  identity: DeploymentIdentity,
): Readonly<Record<string, string>> => ({
  "hermes-ambit-scope": scope,
  "hermes-ambit-deployment": hermesName(identity),
});
