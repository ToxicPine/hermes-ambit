import { Context, Effect } from "effect";

import type { CloudError } from "./errors.js";

export type UserVolumeService = {
  readonly readText: (path: string) => Effect.Effect<string, CloudError>;
  readonly readTextIfExists: (
    path: string,
  ) => Effect.Effect<string | undefined, CloudError>;
  readonly writeText: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, CloudError>;
};

export class UserVolume extends Context.Tag("@cardelli/shared/UserVolume")<
  UserVolume,
  UserVolumeService
>() {}
