import { Effect } from "effect";

import { emitCloudEvent } from "./log.js";
import type { DeploymentIdentity, DeploymentDriver } from "./model.js";

export const makeDeployment = <
  PlanInput extends DeploymentIdentity,
  Plan,
  Status,
  ResourceRef extends DeploymentIdentity = PlanInput,
>(
  driver: DeploymentDriver<PlanInput, Plan, Status, ResourceRef>,
) => {
  const preview = (identity: PlanInput) =>
    Effect.gen(function* () {
      yield* emitCloudEvent({
        level: "info",
        scope: "deployment",
        operation: "preview",
        resource: identity.name,
        message: "Computing deployment preview",
      });
      return yield* driver.plan(identity);
    });

  const apply = (identity: PlanInput) =>
    Effect.gen(function* () {
      const plan = yield* preview(identity);
      yield* emitCloudEvent({
        level: "info",
        scope: "deployment",
        operation: "apply",
        resource: identity.name,
        message: "Applying deployment preview",
      });
      return yield* driver.apply(plan);
    });

  const restart = (identity: ResourceRef) =>
    Effect.gen(function* () {
      yield* emitCloudEvent({
        level: "info",
        scope: "deployment",
        operation: "restart",
        resource: identity.name,
        message: "Restarting deployment",
      });
      return yield* driver.restart(identity);
    });

  const destroy = (identity: ResourceRef) =>
    Effect.gen(function* () {
      yield* emitCloudEvent({
        level: "info",
        scope: "deployment",
        operation: "destroy",
        resource: identity.name,
        message: "Destroying deployment",
      });
      return yield* driver.destroy(identity);
    });

  return {
    preview,
    apply,
    status: driver.status,
    restart,
    destroy,
  };
};
