# Model List Discovery

Use provider APIs as the source of truth for TUI model choices.

## Google

Use Vertex AI Model Garden publisher models:

- `GET https://{region}-aiplatform.googleapis.com/v1beta1/publishers/{publisher}/models`
- Start with `publisher=google`.
- Filter to Google shared Gemini model ids usable by the v1 Hermes runtime
  config. The current runtime config path is Gemini Developer API, so the model
  summary should not present these choices as Vertex inference targets merely
  because discovery comes from the Vertex publisher catalog.

Docs: https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list

## Azure

Use the Azure Foundry OpenAI-compatible data-plane models endpoint for models
accessible to a concrete Azure OpenAI-compatible resource:

- `GET {endpoint}/openai/models?api-version=2024-10-21`
- The TUI may also need deployed model names, because Azure inference normally
  targets deployments rather than raw model IDs.
- Model summaries should preserve that distinction: Azure entries are catalog
  model IDs, while `config set model.default` expects the deployment name that
  Hermes will send to the Azure OpenAI-compatible runtime.

Docs: https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list?view=rest-azureopenai-2024-10-21
