import { Effect } from "effect";
import { z } from "zod";

import { OperationFailed } from "./errors.js";

const runtimeSecretNamePattern = /^[A-Z][A-Z0-9_]{0,126}$/;

export const RUNTIME_SECRET_NAME_MESSAGE =
  "Runtime secret names must start with an uppercase letter and contain only uppercase letters, numbers, or underscores.";

export const runtimeSecretNameSchema = z.string().regex(
  runtimeSecretNamePattern,
  { message: RUNTIME_SECRET_NAME_MESSAGE },
);

export const isRuntimeSecretName = (name: string): boolean =>
  runtimeSecretNameSchema.safeParse(name).success;

export const validateRuntimeSecretName = (
  operation: string,
  name: string,
): Effect.Effect<void, OperationFailed> =>
  isRuntimeSecretName(name)
    ? Effect.void
    : Effect.fail(
        new OperationFailed({
          operation,
          message: RUNTIME_SECRET_NAME_MESSAGE,
          cause: { name },
        }),
      );

export const runtimeSecretSlugFromName = (name: string): string =>
  name.toLowerCase().replaceAll("_", "-");

export const runtimeSecretNameFromSlug = (slug: string): string | undefined => {
  const name = slug.toUpperCase().replaceAll("-", "_");
  return isRuntimeSecretName(name) ? name : undefined;
};
