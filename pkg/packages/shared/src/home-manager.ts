import { Effect } from "effect";

import { hermesHomeManagerPath } from "./constants.js";
import { UserVolume } from "./user-volume.js";
import type { HomeManagerPatch } from "./model.js";

const managedStart = "# hermes-ambit managed settings";
const managedEnd = "# end hermes-ambit managed settings";

export const renderManagedBlock = (patch: HomeManagerPatch) =>
  [managedStart, patch.block.trim(), managedEnd].join("\n");

export const reconcileHomeManagerConfig = (
  user: string,
  patch: HomeManagerPatch,
) =>
  Effect.gen(function* () {
    const volume = yield* UserVolume;
    const path = hermesHomeManagerPath(user);
    const current = yield* volume.readText(path);
    const rendered = renderManagedBlock(patch);
    const start = current.indexOf(managedStart);
    const end = current.indexOf(managedEnd);

    const next =
      start >= 0 && end >= start
        ? `${current.slice(0, start).trimEnd()}\n${rendered}\n${current
            .slice(end + managedEnd.length)
            .trimStart()}`
        : `${current.trimEnd()}\n\n${rendered}\n`;

    yield* volume.writeText(path, next);
    return next;
  });
