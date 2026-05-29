import type { Effect } from "effect";

import type {
  CloudError,
  DeploymentIdentity,
} from "@cardelli/shared";

export type AzureSubscriptionRef = {
  readonly subscriptionId: string;
};

export type AzureResourceGroupRef = AzureSubscriptionRef & {
  readonly resourceGroupName: string;
};

export type AzureContainerAppRef = AzureResourceGroupRef & {
  readonly containerAppName: string;
};

export type AzureFileState = {
  readonly storageName: string;
  readonly dataSubPath: string;
  readonly nixSubPath: string;
};

export type AzureDeploymentRef = DeploymentIdentity & AzureResourceGroupRef;

export type AzureDeployment = AzureDeploymentRef & {
  readonly location: string;
  readonly environmentId: string;
  readonly state: AzureFileState;
};

export type AzureBoundary = AzureResourceGroupRef & {
  readonly location: string;
};

export type AzureDeployPreview = {
  readonly action: "create" | "ready" | "update";
  readonly boundary: AzureBoundary;
  readonly state: AzureFileState;
  readonly containerAppName: string;
};

export type AzureStatus = {
  readonly deployed: boolean;
  readonly endpoint?: string;
  readonly image?: string;
  readonly latestReadyRevision?: string;
  readonly latestRevision?: string;
  readonly runningStatus?: string;
  readonly provisioningState?: string;
};

export type AzureDiscoveredDeployment = Omit<AzureStatus, "deployed"> & {
  readonly resourceName?: string;
};

export type AzureDeployer = {
  readonly validateSetup: (
    input: AzureDeployment,
  ) => Effect.Effect<void, CloudError>;
  readonly previewDeploy: (
    input: AzureDeployment,
  ) => Effect.Effect<AzureDeployPreview, CloudError>;
  readonly deploy: (
    input: AzureDeployment,
  ) => Effect.Effect<AzureStatus, CloudError>;
  readonly status: (
    input: AzureDeploymentRef,
  ) => Effect.Effect<AzureStatus, CloudError>;
  readonly discover: (
    boundary: AzureResourceGroupRef,
  ) => Effect.Effect<readonly AzureDiscoveredDeployment[], CloudError>;
  readonly restart: (
    input: AzureDeploymentRef,
  ) => Effect.Effect<AzureStatus, CloudError>;
  readonly destroy: (
    input: AzureDeploymentRef,
  ) => Effect.Effect<AzureStatus, CloudError>;
};
