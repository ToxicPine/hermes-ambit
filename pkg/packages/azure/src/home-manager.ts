import { Effect } from "effect";

import {
  OperationFailed,
  UserVolume,
  readManagedHomeManagerConfig,
  updateManagedHomeManagerConfig,
  type CloudError,
  type HomeManagerModule,
  type UserVolumeService,
} from "@cardelli/shared";

import {
  clearAzureDirectory,
  getAzureFileShareForManagedEnvironmentStorage,
  makeAzureFilesUserVolume,
  type AzureFileShareRef,
} from "./azure-files.js";
import type { AzureAuthContext } from "./client.js";
import { makeAzureDriver } from "./deployment.js";
import type { AzureDeployment, AzureStatus } from "./deployment-types.js";
import { azureManagedEnvironmentStorageRefFromDeployment } from "./environment-storage.js";

const azureUserVolumeForDeployment = (
  armAuth: AzureAuthContext,
  filesAuth: AzureAuthContext,
  deployment: AzureDeployment,
): Effect.Effect<UserVolumeService, CloudError> =>
  Effect.gen(function* () {
    const storageRef =
      yield* azureManagedEnvironmentStorageRefFromDeployment(deployment);
    const share = yield* getAzureFileShareForManagedEnvironmentStorage(
      armAuth,
      storageRef,
    );

    return makeAzureFilesUserVolume(
      filesAuth,
      share,
      deployment.state.dataSubPath,
    );
  });

export const updateAzureHomeManager = (
  armAuth: AzureAuthContext,
  filesAuth: AzureAuthContext,
  update: {
    readonly identity: AzureDeployment;
    readonly user: string;
    readonly module: HomeManagerModule;
  },
): Effect.Effect<AzureStatus, CloudError> =>
  Effect.gen(function* () {
    const driver = makeAzureDriver(armAuth);
    const current = yield* driver.status(update.identity);
    if (!current.deployed) {
      return yield* Effect.fail(
        new OperationFailed({
          operation: "azure.homeManager.service",
          message:
            "Container App must be deployed before config can be updated.",
        }),
      );
    }

    const volume = yield* azureUserVolumeForDeployment(
      armAuth,
      filesAuth,
      update.identity,
    );
    const updateEffect = updateManagedHomeManagerConfig({
      identity: update.identity,
      user: update.user,
      module: update.module,
      restart: driver.restart,
    });

    return yield* Effect.provideService(updateEffect, UserVolume, volume);
  });

const uniqueStatePaths = (deployment: AzureDeployment): readonly string[] =>
  deployment.state.dataSubPath === deployment.state.nixSubPath
    ? [deployment.state.dataSubPath]
    : [deployment.state.dataSubPath, deployment.state.nixSubPath];

const clearAzureStatePaths = (
  filesAuth: AzureAuthContext,
  share: AzureFileShareRef,
  paths: readonly string[],
): Effect.Effect<void, CloudError> => {
  const [path, ...rest] = paths;
  if (!path) return Effect.void;

  return Effect.gen(function* () {
    yield* clearAzureDirectory(filesAuth, { ...share, path });
    return yield* clearAzureStatePaths(filesAuth, share, rest);
  });
};

export const purgeAzureDeploymentState = (
  armAuth: AzureAuthContext,
  filesAuth: AzureAuthContext,
  deployment: AzureDeployment,
): Effect.Effect<AzureStatus, CloudError> =>
  Effect.gen(function* () {
    const storageRef =
      yield* azureManagedEnvironmentStorageRefFromDeployment(deployment);
    const share = yield* getAzureFileShareForManagedEnvironmentStorage(
      armAuth,
      storageRef,
    );

    const status = yield* makeAzureDriver(armAuth).destroy(deployment);
    yield* clearAzureStatePaths(filesAuth, share, uniqueStatePaths(deployment));
    return status;
  });

export const readAzureHomeManagerConfig = (
  armAuth: AzureAuthContext,
  filesAuth: AzureAuthContext,
  deployment: AzureDeployment,
  user: string,
): Effect.Effect<string | undefined, CloudError> =>
  Effect.gen(function* () {
    const current = yield* makeAzureDriver(armAuth).status(deployment);
    if (!current.deployed) {
      return undefined;
    }

    const volume = yield* azureUserVolumeForDeployment(
      armAuth,
      filesAuth,
      deployment,
    );
    return yield* Effect.provideService(
      readManagedHomeManagerConfig(user),
      UserVolume,
      volume,
    );
  });
