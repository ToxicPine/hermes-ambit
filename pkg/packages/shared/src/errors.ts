import { Data } from "effect";

import type { Remediation } from "./model.js";

export class ProviderUnavailable extends Data.TaggedError(
  "ProviderUnavailable",
)<{
  readonly scope: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DiscoveryFailed extends Data.TaggedError("DiscoveryFailed")<{
  readonly scope: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ResourceConflict extends Data.TaggedError("ResourceConflict")<{
  readonly resource: string;
  readonly message: string;
}> {}

export class RemediationRequired extends Data.TaggedError(
  "RemediationRequired",
)<{
  readonly scope: string;
  readonly message: string;
  readonly remediation: Remediation;
}> {}

export class OperationFailed extends Data.TaggedError("OperationFailed")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UserVolumeFailed extends Data.TaggedError("UserVolumeFailed")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CloudError =
  | ProviderUnavailable
  | DiscoveryFailed
  | ResourceConflict
  | RemediationRequired
  | OperationFailed
  | UserVolumeFailed;
