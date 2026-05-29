import type { Effect } from "effect";

import type { CloudError } from "./errors.js";

export type DeploymentIdentity = {
  readonly name: string;
};

export type Remediation = {
  readonly type: "auth" | "url";
  readonly label: string;
  readonly url: string;
};

export type HomeManagerPatch = {
  readonly section?: string;
  readonly block: string;
};

export type DeploymentDriver<
  PlanInput extends DeploymentIdentity,
  Plan,
  Status,
  ResourceRef extends DeploymentIdentity = PlanInput,
> = {
  readonly plan: (identity: PlanInput) => Effect.Effect<Plan, CloudError>;
  readonly apply: (plan: Plan) => Effect.Effect<Status, CloudError>;
  readonly status: (identity: ResourceRef) => Effect.Effect<Status, CloudError>;
  readonly restart: (identity: ResourceRef) => Effect.Effect<Status, CloudError>;
  readonly destroy: (identity: ResourceRef) => Effect.Effect<Status, CloudError>;
};
