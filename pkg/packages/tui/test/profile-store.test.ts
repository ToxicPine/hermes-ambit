import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultProfileRoot,
  makeFileProfileStore,
} from "../src/profile-store.js";

describe("profile store paths", () => {
  test("keeps deployer profiles out of the Hermes runtime profile tree", () => {
    expect(defaultProfileRoot({}, "/home/alice")).toBe(
      "/home/alice/.hermes-ambit/profiles",
    );
  });

  test("keeps an explicit deployer home scoped to profiles", () => {
    expect(
      defaultProfileRoot(
        { HERMES_AMBIT_HOME: "/tmp/hermes-ambit" },
        "/home/alice",
      ),
    ).toBe("/tmp/hermes-ambit/profiles");
  });

  test("reset clears a stale active profile pointer", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-ambit-profile-"));
    try {
      const store = makeFileProfileStore({ rootDir: join(home, "profiles") });

      expect(store.writeActiveProfileName("missing")).toBeUndefined();
      expect(store.deleteProfile("missing")).toEqual({ deleted: false });
      expect(store.readActiveProfileName()).toBeUndefined();
      expect(existsSync(join(home, "active_profile"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
