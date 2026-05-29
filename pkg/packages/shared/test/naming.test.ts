import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";

import {
  HERMES_DEPLOYMENT_NAME_MESSAGE,
  hermesName,
  ownershipMetadata,
  validateHermesDeploymentName,
} from "../src/naming.js";
import {
  RUNTIME_SECRET_NAME_MESSAGE,
  isRuntimeSecretName,
  runtimeSecretNameFromSlug,
  runtimeSecretSlugFromName,
  validateRuntimeSecretName,
} from "../src/runtime-secret.js";

describe("resource naming", () => {
  test("derives provider resource names without lossy normalization", () => {
    expect(hermesName({ name: "demo-agent" })).toBe("hermes-demo-agent");
    expect(hermesName({ name: "Demo_Agent" })).toBe("hermes-Demo_Agent");
  });

  test("uses the exact derived name in ownership metadata", () => {
    expect(ownershipMetadata("gcp", { name: "demo-agent" })).toMatchObject({
      "hermes-managed-scope": "gcp",
      "hermes-managed-deployment": "hermes-demo-agent",
    });
  });

  test("validates the non-lossy deployment identity accepted by cloud resources", () => {
    expect(validateHermesDeploymentName("demo-agent")).toBeUndefined();
    expect(validateHermesDeploymentName("Demo_Agent")).toBe(
      HERMES_DEPLOYMENT_NAME_MESSAGE,
    );
  });

  test("maps runtime secret names to provider-safe slugs", () => {
    expect(isRuntimeSecretName("GOOGLE_API_KEY")).toBe(true);
    expect(isRuntimeSecretName("google-api-key")).toBe(false);
    expect(runtimeSecretSlugFromName("GOOGLE_API_KEY")).toBe("google-api-key");
    expect(runtimeSecretNameFromSlug("google-api-key")).toBe("GOOGLE_API_KEY");
  });

  test("rejects invalid runtime secret names before provider mutation", async () => {
    const result = await Effect.runPromise(
      Effect.either(validateRuntimeSecretName("test.secret", "google-api-key")),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(RUNTIME_SECRET_NAME_MESSAGE);
    }
  });
});
