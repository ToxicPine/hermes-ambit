export const UNIVERSAL_HERMES_IMAGE = "TODO:published-hermes-ambit-image-url";

export const HERMES_CONTAINER_NAME = "hermes";
export const HERMES_GATEWAY_PORT = 8080;
export const HERMES_DATA_MOUNT_PATH = "/data";
export const HERMES_NIX_MOUNT_PATH = "/nix";
export const HERMES_DATA_VOLUME_NAME = "hermes-data";
export const HERMES_NIX_VOLUME_NAME = "hermes-nix";

export const HERMES_HOME_ROOT_PATH = `${HERMES_DATA_MOUNT_PATH}/homes`;

export const hermesHomeManagerPath = (user: string) =>
  `${HERMES_HOME_ROOT_PATH}/${user}/nixcfg/home.nix`;
