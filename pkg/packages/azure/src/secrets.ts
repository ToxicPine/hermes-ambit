import { Effect } from "effect";

import { OperationFailed, type CloudError } from "@cardelli/shared";

import type { Secret } from "./generated/container-apps/model/CommonDefinitions/secret";
import type { ContainerAppSecret } from "./generated/container-apps/model/containerAppSecret";
import type { AzureAuthContext } from "./client.js";
import {
  createOrUpdateContainerApp,
  findContainerApp,
  listContainerAppSecrets,
  type AzureContainerAppRef,
} from "./container-apps.js";

export type AzureContainerAppSecret = Secret;

const missingContainerApp = (
  operation: string,
  ref: AzureContainerAppRef,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    new OperationFailed({
      operation,
      message: `Container app ${ref.containerAppName} does not exist`,
    }),
  );

export const readContainerAppSecrets = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
): Effect.Effect<readonly ContainerAppSecret[], CloudError> =>
  Effect.map(listContainerAppSecrets(auth, ref), (response) => response.data.value);

export const putContainerAppSecrets = (
  auth: AzureAuthContext,
  ref: AzureContainerAppRef,
  secrets: readonly AzureContainerAppSecret[],
) =>
  Effect.gen(function* () {
    const operation = "azure.containerApps.putSecrets";
    const existing = yield* findContainerApp(auth, ref);
    if (!existing) {
      return yield* missingContainerApp(operation, ref);
    }

    const properties = existing.properties ?? {};
    const configuration = properties.configuration ?? {};
    const updated = yield* createOrUpdateContainerApp(auth, ref, {
      ...existing,
      properties: {
        ...properties,
        configuration: {
          ...configuration,
          secrets: [...secrets],
        },
      },
    });

    return updated.data;
  });
