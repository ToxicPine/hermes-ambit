import { describe, expect, test } from "bun:test";

import {
  HERMES_HOME_MANAGER_READ_COMMAND,
  HERMES_HOME_MANAGER_WRITE_COMMAND,
  isUniversalHermesImageConfigured,
  UNIVERSAL_HERMES_IMAGE,
} from "../src/constants.js";

describe("universal image constant", () => {
  test("treats the checked-in placeholder as not deployable", () => {
    expect(UNIVERSAL_HERMES_IMAGE).toStartWith("TODO:");
    expect(isUniversalHermesImageConfigured()).toBe(false);
  });

  test("accepts a concrete image reference", () => {
    expect(isUniversalHermesImageConfigured("ghcr.io/cardelli/hermes:latest")).toBe(
      true,
    );
  });

  test("rejects blank image values", () => {
    expect(isUniversalHermesImageConfigured("")).toBe(false);
    expect(isUniversalHermesImageConfigured("  ")).toBe(false);
  });

  test("rejects placeholder-looking image values", () => {
    expect(isUniversalHermesImageConfigured("TODO")).toBe(false);
    expect(isUniversalHermesImageConfigured("todo:publish-me")).toBe(false);
  });
});

describe("Home Manager managed config constants", () => {
  test("point at the in-container managed Home Manager helpers", () => {
    expect(HERMES_HOME_MANAGER_READ_COMMAND).toBe(
      "/opt/app/bin/read-managed-hm",
    );
    expect(HERMES_HOME_MANAGER_WRITE_COMMAND).toBe(
      "/opt/app/bin/write-managed-hm",
    );
  });
});
