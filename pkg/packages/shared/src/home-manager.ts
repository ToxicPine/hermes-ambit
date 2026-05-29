import { Effect } from "effect";

import { hermesManagedHomeManagerPath } from "./constants.js";
import { OperationFailed } from "./errors.js";
import { UserVolume } from "./user-volume.js";
import { emitCloudEvent } from "./log.js";
import type {
  DeploymentIdentity,
  HomeManagerPatch,
} from "./model.js";
import type { CloudError } from "./errors.js";

const emptyManagedModule = "{ ... }:\n{\n}\n";

const managedName = (patch: HomeManagerPatch): string =>
  patch.section ? `settings:${patch.section}` : "settings";

export const homeManagerPatchMarkers = (
  patch: HomeManagerPatch,
): { readonly start: string; readonly end: string } => {
  const name = managedName(patch);
  return {
    start: `# hermes-ambit managed ${name}`,
    end: `# end hermes-ambit managed ${name}`,
  };
};

export const renderManagedBlock = (patch: HomeManagerPatch) => {
  const markers = homeManagerPatchMarkers(patch);
  return [markers.start, patch.block.trim(), markers.end].join("\n");
};

const assignmentPathPattern = /^\s*([A-Za-z0-9_.-]+)\s*=/;

const assignmentPath = (line: string): string | undefined =>
  assignmentPathPattern.exec(line)?.[1];

const assignedPaths = (block: string): ReadonlySet<string> =>
  new Set(
    block
      .split("\n")
      .map(assignmentPath)
      .filter((path): path is string => path !== undefined),
  );

const withoutAssignedPaths = (
  current: string,
  paths: ReadonlySet<string>,
): string =>
  paths.size === 0
    ? current
    : current
        .split("\n")
        .filter((line) => {
          const path = assignmentPath(line);
          return path === undefined || !paths.has(path);
        })
        .join("\n");

export const mergeManagedPatch = (
  existing: string | undefined,
  patch: HomeManagerPatch,
): Effect.Effect<string, OperationFailed> => {
  const current = withoutAssignedPaths(
    existing ?? emptyManagedModule,
    assignedPaths(patch.block),
  );
  const rendered = renderManagedBlock(patch);
  const markers = homeManagerPatchMarkers(patch);
  const start = current.indexOf(markers.start);
  const end = current.indexOf(markers.end);

  if (start >= 0 && end >= start) {
    return Effect.succeed(
      `${current.slice(0, start).trimEnd()}\n${rendered}\n${current
        .slice(end + markers.end.length)
        .trimStart()}`,
    );
  }

  const moduleEnd = current.trimEnd().lastIndexOf("}");
  if (moduleEnd < 0) {
    return Effect.fail(
      new OperationFailed({
        operation: "homeManager.mergeManagedPatch",
        message: "Managed Home Manager module is not a Nix module attrset.",
      }),
    );
  }

  return Effect.succeed(
    `${current.slice(0, moduleEnd).trimEnd()}\n\n${rendered}\n${current.slice(
      moduleEnd,
    )}`,
  );
};

export const reconcileHomeManagerConfig = (
  user: string,
  patch: HomeManagerPatch,
) =>
  Effect.gen(function* () {
    const volume = yield* UserVolume;
    const managedPath = hermesManagedHomeManagerPath(user);
    const currentManaged = yield* volume.readTextIfExists(managedPath);
    const nextManaged = yield* mergeManagedPatch(currentManaged, patch);
    yield* volume.writeText(managedPath, nextManaged);
    return nextManaged;
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
  readonly patch: HomeManagerPatch;
  readonly restart: (identity: ResourceRef) => Effect.Effect<Status, CloudError>;
}): Effect.Effect<Status, CloudError, UserVolume> =>
  Effect.gen(function* () {
    yield* emitCloudEvent({
      level: "info",
      scope: "config",
      operation: "home-manager.update",
      resource: update.identity.name,
      message: `Updating Home Manager config for ${update.user}`,
    });
    yield* reconcileHomeManagerConfig(update.user, update.patch);
    yield* emitCloudEvent({
      level: "info",
      scope: "deployment",
      operation: "restart",
      resource: update.identity.name,
      message: "Restarting deployment after config update",
    });
    return yield* update.restart(update.identity);
  });
