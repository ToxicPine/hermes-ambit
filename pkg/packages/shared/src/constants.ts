import { z } from "zod";

export const UNIVERSAL_HERMES_IMAGE =
  "ghcr.io/toxicpine/container-agent:latest";

export const universalHermesImageSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.toUpperCase().startsWith("TODO"));

export const isUniversalHermesImageConfigured = (
  image = UNIVERSAL_HERMES_IMAGE,
): boolean => universalHermesImageSchema.safeParse(image).success;

export const HERMES_CONTAINER_NAME = "hermes";
export const HERMES_GATEWAY_PORT = 8080;
export const HERMES_DATA_MOUNT_PATH = "/data";
export const HERMES_APP_PREFIX_PATH = "/opt/app";
export const HERMES_HOME_MANAGER_READ_COMMAND = `${HERMES_APP_PREFIX_PATH}/bin/read-managed-hm`;
export const HERMES_HOME_MANAGER_WRITE_COMMAND = `${HERMES_APP_PREFIX_PATH}/bin/write-managed-hm`;
export const HERMES_NIX_MOUNT_PATH = "/nix";
export const HERMES_NIX_VOLUME_NAME = "hermes-nix";
export const HERMES_DATA_VOLUME_NAME = "hermes-data";

export const HERMES_HOME_ROOT_PATH = `${HERMES_DATA_MOUNT_PATH}/homes`;

export const hermesHomeManagerPath = (user: string) =>
  `${HERMES_HOME_ROOT_PATH}/${user}/nixcfg/home.nix`;

export const hermesManagedHomeManagerPath = (user: string) =>
  `${HERMES_HOME_ROOT_PATH}/${user}/nixcfg/managed.nix`;
