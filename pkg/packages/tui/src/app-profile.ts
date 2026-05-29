import { z } from "zod";
import {
  HERMES_DEPLOYMENT_NAME_MESSAGE,
  HERMES_DEPLOYMENT_NAME_PATTERN,
  validateHermesDeploymentName,
} from "@cardelli/shared";

import type { AppError } from "./types.js";

const deploymentNameSchema = z.string().regex(HERMES_DEPLOYMENT_NAME_PATTERN);

const gcpProfileProviderSchema = z.object({
  projectId: z.string().min(1),
  region: z.string().min(1),
  serviceAccount: z.string().min(1).optional(),
  state: z.object({
    server: z.string().min(1),
    dataPath: z.string().min(1),
    nixPath: z.string().min(1),
  }),
});

const azureProfileProviderSchema = z.object({
  subscriptionId: z.string().min(1),
  resourceGroupName: z.string().min(1),
  location: z.string().min(1),
  environmentId: z.string().min(1),
  openaiCompatibleEndpoint: z.string().min(1).optional(),
  state: z.object({
    storageName: z.string().min(1),
    dataSubPath: z.string().min(1),
    nixSubPath: z.string().min(1),
  }),
});

export const appProfileSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("gcp"),
    name: z.string().min(1),
    deployment: deploymentNameSchema,
    user: z.string().min(1),
    quotaProjectId: z.string().min(1).optional(),
    gcp: gcpProfileProviderSchema,
  }),
  z.object({
    provider: z.literal("azure"),
    name: z.string().min(1),
    deployment: deploymentNameSchema,
    user: z.string().min(1),
    tenantId: z.string().min(1),
    azure: azureProfileProviderSchema,
  }),
]);

export type AppProfile = z.infer<typeof appProfileSchema>;

const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const validateProfileName = (name: string): AppError | undefined =>
  profileNamePattern.test(name)
    ? undefined
    : {
        code: "profile.invalid",
        message: [
          "Profile names must start with a lowercase letter or number",
          "and contain only lowercase letters, numbers, dashes, or underscores.",
        ].join(" "),
      };

export const validateDeploymentName = (name: string): AppError | undefined =>
  validateHermesDeploymentName(name) === undefined
    ? undefined
    : {
        code: "args.invalid",
        message: HERMES_DEPLOYMENT_NAME_MESSAGE,
      };
