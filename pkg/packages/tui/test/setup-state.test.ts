import { describe, expect, test } from "bun:test";
import { HERMES_DEPLOYMENT_NAME_MESSAGE } from "@cardelli/shared";

import {
  draftFromArgs,
  profileFromDraft,
  setSetupDraftField,
  setupDraftFields,
  setupDraftMissingFields,
  validateDraft,
} from "../src/setup-state.js";

const keys = (fields: readonly { readonly key: string }[]) =>
  fields.map((field) => field.key);

describe("setup draft fields", () => {
  test("treats a GCP shared state path as the NFS state base path", () => {
    const draft = draftFromArgs({
      provider: "gcp",
      deployment: "demo",
      fields: {
        project: "project",
        region: "us-central1",
        "state-server": "10.0.0.8",
        "state-path": "/exports/hermes",
      },
    });

    expect(validateDraft(draft)).toEqual([]);
    expect(keys(setupDraftMissingFields(draft))).toEqual([]);
    expect(keys(setupDraftFields(draft))).toContain("state-path");
    expect(keys(setupDraftFields(draft))).not.toContain("state-data-path");
    const profile = profileFromDraft(draft);
    expect(profile?.provider).toBe("gcp");
    if (profile?.provider === "gcp") {
      expect(profile.gcp.state.dataPath).toBe("/exports/hermes/data");
      expect(profile.gcp.state.nixPath).toBe("/exports/hermes/nix");
    }
  });

  test("shows split GCP NFS paths when no shared state path is set", () => {
    const draft = draftFromArgs({
      provider: "gcp",
      deployment: "demo",
      fields: {
        project: "project",
        region: "us-central1",
        "state-server": "10.0.0.8",
      },
    });

    expect(keys(setupDraftMissingFields(draft))).toEqual([
      "state-data-path",
      "state-nix-path",
    ]);
  });

  test("keeps Azure setup fields provider-specific", () => {
    const draft = draftFromArgs({
      provider: "azure",
      deployment: "demo",
      fields: {
        tenant: "tenant",
        subscription: "subscription",
      },
    });

    expect(keys(setupDraftMissingFields(draft))).toEqual([
      "resource-group",
      "location",
      "environment-id",
      "storage-name",
    ]);
    expect(keys(setupDraftFields(draft))).not.toContain("project");
  });

  test("does not construct a profile from an invalid draft", () => {
    const draft = draftFromArgs({
      provider: "gcp",
      deployment: "demo",
      fields: {
        project: "project",
      },
    });

    expect(validateDraft(draft).length).toBeGreaterThan(0);
    expect(profileFromDraft(draft)).toBeUndefined();
  });

  test("rejects deployment identities that would not map cleanly to cloud resources", () => {
    const draft = draftFromArgs({
      provider: "gcp",
      deployment: "Demo_Agent",
      fields: {
        project: "project",
        region: "us-central1",
        "state-server": "10.0.0.8",
        "state-path": "/exports/hermes",
      },
    });

    expect(validateDraft(draft).map((error) => error.message)).toContain(
      HERMES_DEPLOYMENT_NAME_MESSAGE,
    );
    expect(profileFromDraft(draft)).toBeUndefined();
  });

  test("keeps the Azure model endpoint optional and profile-scoped", () => {
    const draft = draftFromArgs({
      provider: "azure",
      deployment: "demo",
      fields: {
        tenant: "tenant",
        subscription: "subscription",
        "resource-group": "hermes",
        location: "eastus",
        "environment-id": "/subscriptions/subscription/resourceGroups/hermes/providers/Microsoft.App/managedEnvironments/hermes",
        "storage-name": "hermes",
        endpoint: "https://example.openai.azure.com",
      },
    });

    const profile = profileFromDraft(draft);

    expect(validateDraft(draft)).toEqual([]);
    expect(keys(setupDraftFields(draft))).toContain("endpoint");
    expect(profile?.provider).toBe("azure");
    if (profile?.provider === "azure") {
      expect(profile.azure.openaiCompatibleEndpoint).toBe(
        "https://example.openai.azure.com",
      );
    }
    expect(keys(setupDraftFields(draftFromArgs({ provider: "gcp" })))).not.toContain(
      "endpoint",
    );
  });

  test("clears provider-specific fields when the provider changes", () => {
    const gcpDraft = draftFromArgs({
      provider: "gcp",
      deployment: "demo",
      fields: {
        project: "project",
        region: "us-central1",
        "state-server": "10.0.0.8",
        "state-path": "/exports/hermes",
      },
    });

    const azureDraft = setSetupDraftField(gcpDraft, "provider", "azure");

    expect(azureDraft.provider).toBe("azure");
    expect(azureDraft.fields).toEqual({});
    expect(keys(setupDraftMissingFields(azureDraft))).toEqual([
      "tenant",
      "subscription",
      "resource-group",
      "location",
      "environment-id",
      "storage-name",
    ]);
  });

  test("switches between shared and split GCP state paths cleanly", () => {
    const shared = draftFromArgs({
      provider: "gcp",
      deployment: "demo",
      fields: {
        project: "project",
        region: "us-central1",
        "state-server": "10.0.0.8",
        "state-path": "/exports/hermes",
      },
    });

    const split = setSetupDraftField(
      setSetupDraftField(shared, "state-path", ""),
      "state-data-path",
      "/exports/hermes-data",
    );

    expect(split.fields["state-path"]).toBeUndefined();
    expect(split.fields["state-data-path"]).toBe("/exports/hermes-data");
    expect(keys(setupDraftFields(split))).toContain("state-nix-path");
  });

  test("keeps the GCP runtime service account optional and provider-specific", () => {
    const draft = draftFromArgs({
      provider: "gcp",
      deployment: "demo",
      fields: {
        project: "project",
        region: "us-central1",
        "service-account": "hermes-runtime@project.iam.gserviceaccount.com",
        "state-server": "10.0.0.8",
        "state-path": "/exports/hermes",
      },
    });

    const profile = profileFromDraft(draft);

    expect(validateDraft(draft)).toEqual([]);
    expect(keys(setupDraftFields(draft))).toContain("service-account");
    expect(profile?.provider).toBe("gcp");
    if (profile?.provider === "gcp") {
      expect(profile.gcp.serviceAccount).toBe(
        "hermes-runtime@project.iam.gserviceaccount.com",
      );
    }
    expect(keys(setupDraftFields(draftFromArgs({ provider: "azure" })))).not.toContain(
      "service-account",
    );
  });
});
