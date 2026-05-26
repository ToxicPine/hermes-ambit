import type { Effect } from "effect";

import type { CloudError } from "./errors.js";

export type DeploymentIdentity = {
  readonly name: string;
};

export type Remediation = {
  readonly label: string;
  readonly url: string;
};

export type HomeManagerPatch = {
  readonly block: string;
};

export type HomeManagerUpdate<Identity extends DeploymentIdentity> = {
  readonly identity: Identity;
  readonly user: string;
  readonly patch: HomeManagerPatch;
};

export type DeploymentDriver<Identity extends DeploymentIdentity, Plan, Status> = {
  readonly plan: (identity: Identity) => Effect.Effect<Plan, CloudError>;
  readonly apply: (plan: Plan) => Effect.Effect<Status, CloudError>;
  readonly status: (identity: Identity) => Effect.Effect<Status, CloudError>;
  readonly restart: (identity: Identity) => Effect.Effect<Status, CloudError>;
  readonly destroy: (identity: Identity) => Effect.Effect<Status, CloudError>;
};
