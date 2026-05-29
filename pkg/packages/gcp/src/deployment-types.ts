import type { Effect } from "effect";

import type { CloudError, DeploymentIdentity } from "@cardelli/shared";

export type GcpDeploymentRef = DeploymentIdentity & {
  readonly projectId: string;
  readonly region: string;
};

export type GcpNfsState = {
  readonly server: string;
  readonly dataPath: string;
  readonly nixPath: string;
};

export type GcpDeployment = GcpDeploymentRef & {
  readonly state: GcpNfsState;
  readonly serviceAccount?: string;
};

export type GcpBoundary = {
  readonly projectId: string;
  readonly region: string;
};

export type GcpDeployPreview = {
  readonly action: "create" | "ready" | "update";
  readonly boundary: GcpBoundary;
  readonly state: GcpNfsState;
  readonly serviceName: string;
};

export type GcpStatus = {
  readonly deployed: boolean;
  readonly endpoint?: string;
  readonly image?: string;
  readonly latestReadyRevision?: string;
  readonly latestCreatedRevision?: string;
  readonly reconciling?: boolean;
};

export type GcpDiscoveredDeployment = Omit<GcpStatus, "deployed"> & {
  readonly resourceName?: string;
};

export type GcpDeployer = {
  readonly validateSetup: (
    input: GcpDeployment,
  ) => Effect.Effect<void, CloudError>;
  readonly previewDeploy: (
    input: GcpDeployment,
  ) => Effect.Effect<GcpDeployPreview, CloudError>;
  readonly deploy: (
    input: GcpDeployment,
  ) => Effect.Effect<GcpStatus, CloudError>;
  readonly status: (
    input: GcpDeploymentRef,
  ) => Effect.Effect<GcpStatus, CloudError>;
  readonly discover: (
    boundary: GcpBoundary,
  ) => Effect.Effect<readonly GcpDiscoveredDeployment[], CloudError>;
  readonly restart: (
    input: GcpDeploymentRef,
  ) => Effect.Effect<GcpStatus, CloudError>;
  readonly destroy: (
    input: GcpDeploymentRef,
  ) => Effect.Effect<GcpStatus, CloudError>;
};
