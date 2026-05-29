export {
  HERMES_CONTAINER_NAME,
  HERMES_DATA_MOUNT_PATH,
  HERMES_DATA_VOLUME_NAME,
  HERMES_GATEWAY_PORT,
  HERMES_HOME_MANAGER_READ_COMMAND,
  HERMES_HOME_MANAGER_WRITE_COMMAND,
  HERMES_NIX_MOUNT_PATH,
  HERMES_NIX_VOLUME_NAME,
  UNIVERSAL_HERMES_IMAGE,
  isUniversalHermesImageConfigured,
} from "./constants.js";

export { makeDeployment } from "./deployment.js";

export {
  DiscoveryFailed,
  OperationFailed,
  ProviderUnavailable,
  RemediationRequired,
  ResourceConflict,
  UserVolumeFailed,
} from "./errors.js";
export type { CloudError } from "./errors.js";

export {
  emptyManagedModule,
  readManagedHomeManagerConfig,
  writeManagedHomeManagerConfig,
  updateManagedHomeManagerConfig,
} from "./home-manager.js";

export {
  expectHttpStatus,
  failHttpResponse,
  invokeHttp,
  invokeJsonHttp,
  sendAuthorizedHttp,
} from "./http.js";
export type { HttpResponse } from "./http.js";

export { CloudLog, emitCloudEvent } from "./log.js";
export type { CloudEvent } from "./log.js";

export type {
  DeploymentDriver,
  DeploymentIdentity,
  HomeManagerModule,
  Remediation,
} from "./model.js";

export {
  HERMES_DEPLOYMENT_NAME_MESSAGE,
  HERMES_DEPLOYMENT_NAME_PATTERN,
  OWNERSHIP_DEPLOYMENT_KEY,
  OWNERSHIP_SCOPE_KEY,
  hermesDeploymentNameSchema,
  hermesName,
  ownershipMetadata,
  validateHermesDeploymentIdentity,
  validateHermesDeploymentName,
} from "./naming.js";

export {
  RUNTIME_SECRET_NAME_MESSAGE,
  isRuntimeSecretName,
  runtimeSecretSlugFromName,
  runtimeSecretNameSchema,
  validateRuntimeSecretName,
} from "./runtime-secret.js";

export { UserVolume } from "./user-volume.js";
export type { UserVolumeService } from "./user-volume.js";
