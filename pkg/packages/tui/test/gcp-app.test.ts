import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeGcpApp } from "../src/gcp-app.js";

describe("GCP app model discovery", () => {
  test("requests the full publisher-model view before filtering supported models", async () => {
    const seenUrls: URL[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seenUrls.push(url);
      return new Response(
        JSON.stringify({
          publisherModels: [
            {
              name: "publishers/google/models/gemini-3-flash-preview",
              supportedActions: {
                viewRestApi: {
                  title: "REST",
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    try {
      const app = makeGcpApp({
        token: () => Effect.succeed({ accessToken: "token" }),
      });

      const models = await Effect.runPromise(
        app.listSupportedModels("us-central1"),
      );

      expect(seenUrls[0]?.searchParams.get("view")).toBe(
        "PUBLISHER_MODEL_VIEW_FULL",
      );
      expect(models.summary).toEqual([
        {
          id: "gemini-3-flash-preview",
          route: "gemini/developer-api",
          runtimeTarget: "model-id",
        },
      ]);
      expect(models.raw).toEqual([
        {
          id: "gemini-3-flash-preview",
          supportsRestApi: true,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
