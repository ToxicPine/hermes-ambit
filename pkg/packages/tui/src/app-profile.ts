import { z } from "zod";
import {
  HERMES_DEPLOYMENT_NAME_MESSAGE,
  hermesDeploymentNameSchema,
  validateHermesDeploymentName,
} from "@cardelli/shared";

import type { AppError } from "./types.js";

const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const profileNameMessage = [
  "Profile names must start with a lowercase letter or number",
  "and contain only lowercase letters, numbers, dashes, or underscores.",
].join(" ");

export const profileNameSchema = z.string().regex(profileNamePattern, {
  message: profileNameMessage,
});

const gcpProfileProviderSchema = z.object({
  projectId: z.string().min(1),
  region: z.string().min(1),
  serviceAccount: z.string().min(1).optional(),
  model: z.string().min(1),
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
  openaiCompatibleEndpoint: z.string().min(1),
  modelDeployment: z.string().min(1),
  state: z.object({
    storageName: z.string().min(1),
    dataSubPath: z.string().min(1),
    nixSubPath: z.string().min(1),
  }),
});

export const appProfileSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("gcp"),
    name: profileNameSchema,
    deployment: hermesDeploymentNameSchema,
    user: z.string().min(1),
    quotaProjectId: z.string().min(1).optional(),
    gcp: gcpProfileProviderSchema,
  }),
  z.object({
    provider: z.literal("azure"),
    name: profileNameSchema,
    deployment: hermesDeploymentNameSchema,
    user: z.string().min(1),
    tenantId: z.string().min(1),
    azure: azureProfileProviderSchema,
  }),
]);

export type AppProfile = z.infer<typeof appProfileSchema>;

export const validateProfileName = (name: string): AppError | undefined =>
  profileNameSchema.safeParse(name).success
    ? undefined
    : {
        code: "profile.invalid",
        message: profileNameMessage,
      };

export const validateDeploymentName = (name: string): AppError | undefined =>
  validateHermesDeploymentName(name) === undefined
    ? undefined
    : {
        code: "args.invalid",
        message: HERMES_DEPLOYMENT_NAME_MESSAGE,
      };
