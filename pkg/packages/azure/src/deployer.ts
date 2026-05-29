import { Effect } from "effect";

import { makeDeployment } from "@cardelli/shared";

import type { AzureAuthContext } from "./client.js";
import {
  listAzureDeploymentStatuses,
  makeAzureDriver,
  type AzurePlan,
} from "./deployment.js";
import type {
  AzureDeployer,
  AzureDeployPreview,
  AzureDeployment,
} from "./deployment-types.js";
import { requireAzureDeploymentStateStorage } from "./environment-storage.js";

const azureDeployPreview = (plan: AzurePlan): AzureDeployPreview => ({
  action: plan.action,
  boundary: plan.boundary,
  state: plan.state,
  containerAppName: plan.containerAppRef.containerAppName,
});

export const makeAzureDeployer = (auth: AzureAuthContext): AzureDeployer => {
  const driver = makeAzureDriver(auth);
  const deployment = makeDeployment(driver);

  return {
    validateSetup: (input: AzureDeployment) =>
      Effect.asVoid(requireAzureDeploymentStateStorage(auth, input)),
    previewDeploy: (input: AzureDeployment) =>
      Effect.map(deployment.preview(input), azureDeployPreview),
    deploy: (input) => deployment.apply(input),
    status: (input) => deployment.status(input),
    discover: (boundary) => listAzureDeploymentStatuses(auth, boundary),
    restart: (input) => deployment.restart(input),
    destroy: (input) => deployment.destroy(input),
  };
};
