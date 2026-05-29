import { Effect } from "effect";

import { hermesManagedHomeManagerPath } from "./constants.js";
import { UserVolume } from "./user-volume.js";
import { emitCloudEvent } from "./log.js";
import type { DeploymentIdentity, HomeManagerModule } from "./model.js";
import type { CloudError } from "./errors.js";

export const emptyManagedModule = "{ lib, ... }:\n{\n}\n";

export const writeManagedHomeManagerConfig = (
  user: string,
  module: HomeManagerModule,
) =>
  Effect.gen(function* () {
    const volume = yield* UserVolume;
    yield* volume.writeText(hermesManagedHomeManagerPath(user), module);
    return module;
  });

export const readManagedHomeManagerConfig = (user: string) =>
  Effect.gen(function* () {
    const volume = yield* UserVolume;
    return yield* volume.readTextIfExists(hermesManagedHomeManagerPath(user));
  });

export const updateManagedHomeManagerConfig = <
  ResourceRef extends DeploymentIdentity,
  Status,
>(update: {
  readonly identity: ResourceRef;
  readonly user: string;
  readonly module: HomeManagerModule;
  readonly restart: (
    identity: ResourceRef,
  ) => Effect.Effect<Status, CloudError>;
}): Effect.Effect<Status, CloudError, UserVolume> =>
  Effect.gen(function* () {
    yield* emitCloudEvent({
      level: "info",
      scope: "config",
      operation: "home-manager.update",
      resource: update.identity.name,
      message: `Updating Home Manager config for ${update.user}`,
    });
    yield* writeManagedHomeManagerConfig(update.user, update.module);
    yield* emitCloudEvent({
      level: "info",
      scope: "deployment",
      operation: "restart",
      resource: update.identity.name,
      message: "Restarting deployment after config update",
    });
    return yield* update.restart(update.identity);
  });
