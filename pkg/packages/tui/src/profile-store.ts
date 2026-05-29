import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  appProfileSchema,
  validateProfileName,
  type AppProfile,
} from "./app-profile.js";
import type { AppError } from "./types.js";

export type ProfileStore = {
  readonly readActiveProfileName: () => string | undefined | AppError;
  readonly writeActiveProfileName: (name: string) => AppError | undefined;
  readonly readProfile: (name: string) => AppProfile | AppError;
  readonly writeProfile: (profile: AppProfile) => AppError | undefined;
  readonly deleteProfile: (
    name: string,
  ) => { readonly deleted: boolean } | AppError;
};

export type ProfileStoreEnv = Readonly<Record<string, string | undefined>>;

export type FileProfileStoreOptions = {
  readonly rootDir: string;
};

const profileFileName = (name: string) => `${name}.json`;
const activeProfileFileName = "active_profile";

const nodeErrorSchema = z
  .object({
    code: z.string(),
  })
  .passthrough();

const errorCode = (cause: unknown): string | undefined => {
  const parsed = nodeErrorSchema.safeParse(cause);
  return parsed.success ? parsed.data.code : undefined;
};

const profileReadFailed = (message: string): AppError => ({
  code: "profile.readFailed",
  message,
});

const profileWriteFailed = (message: string): AppError => ({
  code: "profile.writeFailed",
  message,
});

const profileDeleteFailed = (message: string): AppError => ({
  code: "profile.deleteFailed",
  message,
});

export const defaultProfileRoot = (
  env: ProfileStoreEnv = {},
  homeDirectory = homedir(),
): string => {
  const configured = env.HERMES_AMBIT_HOME?.trim();
  return resolve(
    configured && configured.length > 0
      ? join(configured, "profiles")
      : join(homeDirectory, ".hermes-ambit", "profiles"),
  );
};

const profilePath = (rootDir: string, profileName: string): string =>
  join(rootDir, profileFileName(profileName));

const activeProfilePath = (rootDir: string): string =>
  join(dirname(rootDir), activeProfileFileName);

export const makeFileProfileStore = (
  options: FileProfileStoreOptions,
): ProfileStore => {
  const rootDir = resolve(options.rootDir);
  const activePath = activeProfilePath(rootDir);

  const readActiveProfileName = (): string | undefined | AppError => {
    if (!existsSync(activePath)) {
      return undefined;
    }

    let name: string;
    try {
      name = readFileSync(activePath, "utf8").trim();
    } catch {
      return profileReadFailed("Could not read active profile.");
    }

    const nameError = validateProfileName(name);
    return nameError ?? name;
  };

  const writeActiveProfileName = (name: string): AppError | undefined => {
    const nameError = validateProfileName(name);
    if (nameError) return nameError;

    const tmpPath = join(
      dirname(activePath),
      `.${activeProfileFileName}.${process.pid}.${Date.now()}.tmp`,
    );

    try {
      mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
      writeFileSync(tmpPath, `${name}\n`, { mode: 0o600 });
      renameSync(tmpPath, activePath);
      return undefined;
    } catch (cause) {
      const code = errorCode(cause);
      return profileWriteFailed(
        code === "EACCES"
          ? `Could not write active profile ${name}; permission denied.`
          : `Could not write active profile ${name}.`,
      );
    }
  };

  const readProfile = (name: string): AppProfile | AppError => {
    const nameError = validateProfileName(name);
    if (nameError) return nameError;

    const path = profilePath(rootDir, name);
    if (!existsSync(path)) {
      return {
        code: "profile.notFound",
        message: `Profile ${name} is not configured. Run setup first.`,
      };
    }

    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      const parsed = appProfileSchema.safeParse(value);
      if (!parsed.success) {
        return profileReadFailed(
          `Profile ${name} is not a valid deployer profile.`,
        );
      }
      return parsed.data.name === name
        ? parsed.data
        : profileReadFailed(
            `Profile ${name} contains mismatched profile name ${parsed.data.name}.`,
          );
    } catch {
      return profileReadFailed(`Could not read profile ${name}.`);
    }
  };

  const writeProfile = (profile: AppProfile): AppError | undefined => {
    const nameError = validateProfileName(profile.name);
    if (nameError) return nameError;
    const parsed = appProfileSchema.safeParse(profile);
    if (!parsed.success) {
      return profileWriteFailed(
        `Profile ${profile.name} is not a valid deployer profile.`,
      );
    }

    const path = profilePath(rootDir, profile.name);
    const tmpPath = join(
      dirname(path),
      `.${profile.name}.${process.pid}.${Date.now()}.tmp`,
    );

    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(tmpPath, `${JSON.stringify(profile, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tmpPath, path);
      return undefined;
    } catch (cause) {
      const code = errorCode(cause);
      return profileWriteFailed(
        code === "EACCES"
          ? `Could not write profile ${profile.name}; permission denied.`
          : `Could not write profile ${profile.name}.`,
      );
    }
  };

  const deleteProfile = (
    name: string,
  ): { readonly deleted: boolean } | AppError => {
    const nameError = validateProfileName(name);
    if (nameError) return nameError;

    const path = profilePath(rootDir, name);
    try {
      const deleted = existsSync(path);
      if (deleted) {
        unlinkSync(path);
      }
      const activeName = readActiveProfileName();
      if (activeName === name && existsSync(activePath)) {
        unlinkSync(activePath);
      }
      return { deleted };
    } catch (cause) {
      const code = errorCode(cause);
      return profileDeleteFailed(
        code === "EACCES"
          ? `Could not delete profile ${name}; permission denied.`
          : `Could not delete profile ${name}.`,
      );
    }
  };

  return {
    readActiveProfileName,
    writeActiveProfileName,
    readProfile,
    writeProfile,
    deleteProfile,
  };
};
