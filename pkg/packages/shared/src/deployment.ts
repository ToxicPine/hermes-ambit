import { Effect } from "effect";

import { reconcileHomeManagerConfig } from "./home-manager.js";
import type {
  DeploymentIdentity,
  DeploymentDriver,
  HomeManagerUpdate,
} from "./model.js";

export const makeDeployment = <Identity extends DeploymentIdentity, Plan, Status>(
  driver: DeploymentDriver<Identity, Plan, Status>,
) => {
  const apply = (identity: Identity) =>
    Effect.gen(function* () {
      const plan = yield* driver.plan(identity);
      return yield* driver.apply(plan);
    });

  const updateHomeManager = (update: HomeManagerUpdate<Identity>) =>
    Effect.gen(function* () {
      yield* reconcileHomeManagerConfig(update.user, update.patch);
      return yield* driver.restart(update.identity);
    });

  return {
    plan: driver.plan,
    apply,
    status: driver.status,
    updateHomeManager,
    destroy: driver.destroy,
  };
};
