type ProviderDeployPreviewResource = {
  readonly action: "create" | "reuse" | "update";
  readonly resourceKind:
    | "cloud-run-service"
    | "container-app"
    | "nfs-state"
    | "managed-environment-storage";
  readonly resourceName: string;
};

export type ProviderDeployPreviewSummary =
  | {
      readonly boundary: {
        readonly projectId: string;
        readonly region: string;
      };
      readonly state: {
        readonly kind: "nfs";
        readonly server: string;
        readonly dataPath: string;
        readonly nixPath: string;
      };
      readonly resources: readonly ProviderDeployPreviewResource[];
    }
  | {
      readonly boundary: {
        readonly subscriptionId: string;
        readonly resourceGroupName: string;
        readonly location: string;
      };
      readonly state: {
        readonly kind: "azure-files";
        readonly storageName: string;
        readonly dataSubPath: string;
        readonly nixSubPath: string;
      };
      readonly resources: readonly ProviderDeployPreviewResource[];
    };

export type GcpStatusSummary = {
  readonly deployed: boolean;
  readonly endpoint?: string;
  readonly image?: string;
  readonly latestReadyRevision?: string;
  readonly latestCreatedRevision?: string;
  readonly reconciling?: boolean;
};

export type AzureStatusSummary = {
  readonly deployed: boolean;
  readonly endpoint?: string;
  readonly image?: string;
  readonly latestReadyRevision?: string;
  readonly latestRevision?: string;
  readonly runningStatus?: string;
  readonly provisioningState?: string;
};

export type ProviderStatusSummary = GcpStatusSummary | AzureStatusSummary;

type GcpDiscoveryDeploymentSummary = Omit<GcpStatusSummary, "deployed"> & {
  readonly resourceKind: "cloud-run-service";
  readonly resourceName?: string;
};

type AzureDiscoveryDeploymentSummary = Omit<AzureStatusSummary, "deployed"> & {
  readonly resourceKind: "container-app";
  readonly resourceName?: string;
};

export type ProviderDiscoverySummary = {
  readonly boundary:
    | {
        readonly projectId: string;
        readonly region: string;
      }
    | {
        readonly subscriptionId: string;
        readonly resourceGroupName: string;
      };
  readonly deployments: readonly (
    | GcpDiscoveryDeploymentSummary
    | AzureDiscoveryDeploymentSummary
  )[];
};

export type SupportedModelSummary =
  | {
      readonly id: string;
      readonly route: "gemini/developer-api";
      readonly runtimeTarget: "model-id";
    }
  | {
      readonly id: string;
      readonly route: "azure-foundry/openai-compatible";
      readonly runtimeTarget: "deployment-name";
    };

export type ProviderConfigSummary = {
  readonly configured: boolean;
  readonly managedModuleHash?: string;
};

export type ProviderConfigRead = ProviderConfigSummary & {
  readonly managedModule?: string;
};

export type ProviderAuthSummary =
  | {
      readonly quotaProjectId?: string;
    }
  | {
      readonly tenantId: string;
      readonly subscriptionId: string;
      readonly expiresAtEpochSeconds: number;
    };
