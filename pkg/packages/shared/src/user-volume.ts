import { Context, Effect } from "effect";

import type { CloudError } from "./errors.js";

export class UserVolume extends Context.Tag("@cardelli/shared/UserVolume")<
  UserVolume,
  {
    readonly readText: (path: string) => Effect.Effect<string, CloudError>;
    readonly writeText: (path: string, contents: string) => Effect.Effect<void, CloudError>;
  }
>() {}
