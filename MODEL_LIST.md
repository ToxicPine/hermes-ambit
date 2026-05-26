# Model List Discovery

Use provider APIs as the source of truth for TUI model choices.

## Google

Use Vertex AI Model Garden publisher models:

- `GET https://{region}-aiplatform.googleapis.com/v1beta1/publishers/{publisher}/models`
- Start with `publisher=google`.
- Filter/shape results for Hermes-supported runtime modes.

Docs: https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list

## Azure

Use the Azure OpenAI data-plane models endpoint for models accessible to an
Azure OpenAI resource:

- `GET {endpoint}/openai/models?api-version=2024-10-21`
- The TUI may also need deployed model names, because Azure inference normally
  targets deployments rather than raw model IDs.

Docs: https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list?view=rest-azureopenai-2024-10-21
