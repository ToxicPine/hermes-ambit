import { describe, expect, test } from "bun:test";

import {
  azureFoundryOpenAICompatibleBaseUrl,
  hermesConfigSetKeysForProvider,
  isAzureFoundryOpenAICompatibleApiMode,
  renderHermesModelModule,
  renderHermesModule,
} from "../src/hermes-config.js";

describe("Hermes config rendering", () => {
  test("renders Azure Foundry OpenAI-compatible model config using Hermes values", () => {
    const module = renderHermesModule({
      model: {
        provider: "azure",
        endpoint: "https://example.openai.azure.com/",
        deploymentName: "gpt-5-mini",
        apiMode: "codex_responses",
      },
    });

    expect(module).toContain("{ lib, ... }:");
    expect(module).toContain('provider = lib.mkForce "azure-foundry";');
    expect(module).toContain(
      'base_url = lib.mkForce "https://example.openai.azure.com/openai/v1";',
    );
    expect(module).toContain('api_mode = lib.mkForce "codex_responses";');
    expect(module).not.toContain("auth_mode");
  });

  test("normalizes Azure Foundry resource endpoints to the Hermes OpenAI v1 base URL", () => {
    expect(
      azureFoundryOpenAICompatibleBaseUrl("https://example.openai.azure.com"),
    ).toBe("https://example.openai.azure.com/openai/v1");
    expect(
      azureFoundryOpenAICompatibleBaseUrl(
        "https://example.openai.azure.com/openai/v1/",
      ),
    ).toBe("https://example.openai.azure.com/openai/v1");
  });

  test("limits Azure direct API mode config to the OpenAI-compatible route", () => {
    expect(isAzureFoundryOpenAICompatibleApiMode("chat_completions")).toBe(
      true,
    );
    expect(isAzureFoundryOpenAICompatibleApiMode("codex_responses")).toBe(true);
    expect(isAzureFoundryOpenAICompatibleApiMode("anthropic_messages")).toBe(
      false,
    );
  });

  test("keeps Azure-only runtime keys out of the GCP config surface", () => {
    expect(hermesConfigSetKeysForProvider("gcp")).not.toContain(
      "model.api_mode",
    );
    expect(hermesConfigSetKeysForProvider("gcp")).not.toContain(
      "model.auth_mode",
    );
    expect(hermesConfigSetKeysForProvider("azure")).toContain("model.api_mode");
    expect(hermesConfigSetKeysForProvider("azure")).not.toContain(
      "model.auth_mode",
    );
  });

  test("keeps provider-derived model fields out of direct config set keys", () => {
    expect(hermesConfigSetKeysForProvider("gcp")).not.toContain(
      "model.provider",
    );
    expect(hermesConfigSetKeysForProvider("azure")).not.toContain(
      "model.provider",
    );
    expect(hermesConfigSetKeysForProvider("gcp")).not.toContain(
      "model.base_url",
    );
    expect(hermesConfigSetKeysForProvider("azure")).not.toContain(
      "model.base_url",
    );
  });

  test("renders a model-only module for provider-specific model selections", () => {
    const module = renderHermesModelModule({
      provider: "gcp",
      model: "gemini-3-flash-preview",
    });

    expect(module).toContain("{ lib, ... }:");
    expect(module).toContain("programs.hermes-agent.settings.model");
    expect(module).toContain('provider = lib.mkForce "gemini";');
    expect(module).toContain('default = lib.mkForce "gemini-3-flash-preview";');
  });
});
