import { Effect } from "effect";

import { makeDeployment } from "@cardelli/shared";

import type { GcpAuthContext } from "./client.js";
import {
  listGcpDeploymentStatuses,
  makeGcpDriver,
  validateGcpNfsState,
  type GcpPlan,
} from "./deployment.js";
import type {
  GcpDeployer,
  GcpDeployPreview,
  GcpDeployment,
} from "./deployment-types.js";

const gcpDeployPreview = (plan: GcpPlan): GcpDeployPreview => ({
  action: plan.action,
  boundary: plan.boundary,
  state: plan.state,
  serviceName: plan.serviceRef.serviceName,
});

export const makeGcpDeployer = (auth: GcpAuthContext): GcpDeployer => {
  const driver = makeGcpDriver(auth);
  const deployment = makeDeployment(driver);

  return {
    validateSetup: (input: GcpDeployment) =>
      validateGcpNfsState("gcp.deployment.state", input.state),
    previewDeploy: (input: GcpDeployment) =>
      Effect.map(deployment.preview(input), gcpDeployPreview),
    deploy: (input) => deployment.apply(input),
    status: (input) => deployment.status(input),
    discover: (boundary) => listGcpDeploymentStatuses(auth, boundary),
    restart: (input) => deployment.restart(input),
    destroy: (input) => deployment.destroy(input),
  };
};
