import { z } from "zod";

const azureSpecsRev = "03635f9c9be65a2d2ca84f07b187173660d541e3";
const gcpRunDiscoveryUrl =
  "https://run.googleapis.com/$discovery/rest?version=v2";
const gcpSecretManagerDiscoveryUrl =
  "https://secretmanager.googleapis.com/$discovery/rest?version=v1";
const gcpAiplatformDiscoveryUrl =
  "https://aiplatform.googleapis.com/$discovery/rest?version=v1beta1";

const containerAppsPath =
  "specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2025-07-01";
const azureSpecsBase = `https://raw.githubusercontent.com/Azure/azure-rest-api-specs/${azureSpecsRev}`;

const containerAppExamples = [
  "ContainerApps_CreateOrUpdate.json",
  "ContainerApps_Delete.json",
  "ContainerApps_Get.json",
  "ContainerApps_GetAuthToken.json",
  "ContainerApps_Kind_FunctionApp_CreateOrUpdate.json",
  "ContainerApps_Kind_WorkflowApp_CreateOrUpdate.json",
  "ContainerApps_ListByResourceGroup.json",
  "ContainerApps_ListBySubscription.json",
  "ContainerApps_ListCustomHostNameAnalysis.json",
  "ContainerApps_ListSecrets.json",
  "ContainerApps_ManagedBy_CreateOrUpdate.json",
  "ContainerApps_Patch.json",
  "ContainerApps_Start.json",
  "ContainerApps_Stop.json",
  "ContainerApps_TcpApp_CreateOrUpdate.json",
  "ManagedEnvironmentsStorages_CreateOrUpdate.json",
  "ManagedEnvironmentsStorages_CreateOrUpdate_NfsAzureFile.json",
  "ManagedEnvironmentsStorages_Delete.json",
  "ManagedEnvironmentsStorages_Get.json",
  "ManagedEnvironmentsStorages_Get_NfsAzureFile.json",
  "ManagedEnvironmentsStorages_List.json",
];

const specs = [
  {
    source: `${containerAppsPath}/ContainerApps.json`,
    output: `openapi/azure/${containerAppsPath}/ContainerApps.json`,
  },
  {
    source: `${containerAppsPath}/ManagedEnvironmentsStorages.json`,
    output: `openapi/azure/${containerAppsPath}/ManagedEnvironmentsStorages.json`,
  },
  {
    source: `${containerAppsPath}/CommonDefinitions.json`,
    output: `openapi/azure/${containerAppsPath}/CommonDefinitions.json`,
  },
  {
    source: "specification/common-types/resource-management/v3/types.json",
    output:
      "openapi/azure/specification/common-types/resource-management/v3/types.json",
  },
  {
    source:
      "specification/common-types/resource-management/v3/managedidentity.json",
    output:
      "openapi/azure/specification/common-types/resource-management/v3/managedidentity.json",
  },
  {
    source: "specification/common-types/resource-management/v5/types.json",
    output:
      "openapi/azure/specification/common-types/resource-management/v5/types.json",
  },
];

for (const spec of specs) {
  const response = await fetch(`${azureSpecsBase}/${spec.source}`);
  if (!response.ok) {
    throw new Error(`failed to fetch ${spec.source}: ${response.status}`);
  }

  await Bun.write(
    spec.output,
    `${JSON.stringify(await response.json(), null, 2)}\n`,
  );
}

for (const example of containerAppExamples) {
  await Bun.write(
    `openapi/azure/${containerAppsPath}/examples/${example}`,
    '{\n  "parameters": {},\n  "responses": {}\n}\n',
  );
}

type DiscoverySchema = {
  readonly $ref?: string;
  readonly type?: string;
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly default?: unknown;
  readonly readOnly?: boolean;
  readonly properties?: Readonly<Record<string, DiscoverySchema>>;
  readonly additionalProperties?: DiscoverySchema | boolean;
  readonly items?: DiscoverySchema;
};

type DiscoveryParameter = DiscoverySchema & {
  readonly location?: "path" | "query";
  readonly required?: boolean;
};

type DiscoveryMethod = {
  readonly id: string;
  readonly path: string;
  readonly httpMethod: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, DiscoveryParameter>>;
  readonly request?: { readonly $ref: string };
  readonly response?: { readonly $ref: string };
};

type DiscoveryResource = {
  readonly methods?: Readonly<Record<string, DiscoveryMethod>>;
  readonly resources?: Readonly<Record<string, DiscoveryResource>>;
};

type DiscoveryDocument = {
  readonly title?: string;
  readonly version: string;
  readonly baseUrl?: string;
  readonly rootUrl?: string;
  readonly schemas?: Readonly<Record<string, DiscoverySchema>>;
  readonly resources?: Readonly<Record<string, DiscoveryResource>>;
};

type OpenApiSchema = {
  readonly $ref?: string;
  readonly type?: string;
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly default?: unknown;
  readonly readOnly?: boolean;
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly additionalProperties?: OpenApiSchema | boolean;
  readonly items?: OpenApiSchema;
};

const discoverySchemaToOpenApi = (schema: DiscoverySchema): OpenApiSchema => {
  if (schema.$ref) {
    return { $ref: `#/components/schemas/${schema.$ref}` };
  }

  const output: {
    $ref?: string;
    type?: string;
    format?: string;
    description?: string;
    enum?: readonly string[];
    pattern?: string;
    default?: unknown;
    readOnly?: boolean;
    properties?: Record<string, OpenApiSchema>;
    additionalProperties?: OpenApiSchema | boolean;
    items?: OpenApiSchema;
  } = {};

  if (schema.type && schema.type !== "any") {
    output.type = schema.type;
  }
  if (schema.format) {
    output.format = schema.format;
  }
  if (schema.description) {
    output.description = schema.description;
  }
  if (schema.enum) {
    output.enum = schema.enum;
  }
  if (schema.pattern) {
    output.pattern = schema.pattern;
  }
  if (schema.default !== undefined) {
    output.default = schema.default;
  }
  if (schema.readOnly) {
    output.readOnly = true;
  }
  if (schema.properties) {
    output.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        discoverySchemaToOpenApi(property),
      ]),
    );
  }
  if (schema.additionalProperties !== undefined) {
    output.additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : discoverySchemaToOpenApi(schema.additionalProperties);
  }
  if (schema.items) {
    output.items = discoverySchemaToOpenApi(schema.items);
  }

  return output;
};

const operationId = (method: DiscoveryMethod) =>
  method.id.replace(/[^A-Za-z0-9_]/g, "_");

const openApiPath = (path: string) => `/${path.replaceAll("{+", "{")}`;

const responseSchema = (method: DiscoveryMethod) =>
  method.response
    ? {
        content: {
          "application/json": {
            schema: {
              $ref: `#/components/schemas/${method.response.$ref}`,
            },
          },
        },
        description: method.description ?? "OK",
      }
    : { description: method.description ?? "OK" };

const openApiOperation = (method: DiscoveryMethod, errorSchemaName: string) => {
  const parameters = Object.entries(method.parameters ?? {}).map(
    ([name, parameter]) => {
      const { location, required, ...schema } = parameter;
      return {
        name,
        in: location === "path" ? "path" : "query",
        required: location === "path" || required === true,
        description: parameter.description,
        schema: discoverySchemaToOpenApi(schema),
      };
    },
  );

  return {
    operationId: operationId(method),
    description: method.description,
    parameters,
    requestBody: method.request
      ? {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: `#/components/schemas/${method.request.$ref}`,
              },
            },
          },
        }
      : undefined,
    responses: {
      200: responseSchema(method),
      default: {
        description: "Error response",
        content: {
          "application/json": {
            schema: {
              $ref: `#/components/schemas/${errorSchemaName}`,
            },
          },
        },
      },
    },
  };
};

const gcpRunJobMethodIds = new Set([
  "run.projects.locations.jobs.create",
  "run.projects.locations.jobs.delete",
  "run.projects.locations.jobs.get",
  "run.projects.locations.jobs.list",
  "run.projects.locations.jobs.patch",
  "run.projects.locations.jobs.run",
]);

const shouldGenerateGcpRunMethod = (method: DiscoveryMethod) =>
  method.id.startsWith("run.projects.locations.operations.") ||
  (method.id.startsWith("run.projects.locations.services.") &&
    !method.id.startsWith("run.projects.locations.services.revisions."));

const shouldGenerateGcpRunJobMethod = (method: DiscoveryMethod) =>
  gcpRunJobMethodIds.has(method.id);

const shouldGenerateGcpSecretManagerMethod = (method: DiscoveryMethod) =>
  method.id === "secretmanager.projects.secrets.create" ||
  method.id === "secretmanager.projects.secrets.addVersion" ||
  method.id === "secretmanager.projects.secrets.delete" ||
  method.id === "secretmanager.projects.secrets.list" ||
  method.id === "secretmanager.projects.secrets.versions.access";

const shouldGenerateGcpAiplatformMethod = (method: DiscoveryMethod) =>
  method.id === "aiplatform.publishers.models.list";

const schemaRefs = (schema: DiscoverySchema | undefined, refs: Set<string>) => {
  if (!schema) {
    return;
  }

  if (schema.$ref) {
    refs.add(schema.$ref);
  }

  for (const property of Object.values(schema.properties ?? {})) {
    schemaRefs(property, refs);
  }

  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    schemaRefs(schema.additionalProperties, refs);
  }

  schemaRefs(schema.items, refs);
};

const methodSchemaRefs = (method: DiscoveryMethod, refs: Set<string>) => {
  if (method.request) {
    refs.add(method.request.$ref);
  }
  if (method.response) {
    refs.add(method.response.$ref);
  }

  for (const parameter of Object.values(method.parameters ?? {})) {
    schemaRefs(parameter, refs);
  }
};

const transitiveSchemas = (
  schemas: Readonly<Record<string, DiscoverySchema>>,
  initial: ReadonlySet<string>,
) => {
  const visited = new Set<string>();
  const pending = [...initial];

  for (const name of pending) {
    if (visited.has(name)) {
      continue;
    }

    const schema = schemas[name];
    if (!schema) {
      continue;
    }

    visited.add(name);

    const refs = new Set<string>();
    schemaRefs(schema, refs);
    pending.push(...refs);
  }

  return Object.fromEntries(
    [...visited].sort().map((name) => [name, schemas[name]]),
  );
};

const collectMethods = (
  resource: DiscoveryResource,
  paths: Record<string, Record<string, unknown>>,
  refs: Set<string>,
  shouldGenerate: (method: DiscoveryMethod) => boolean,
  errorSchemaName: string,
) => {
  for (const method of Object.values(resource.methods ?? {})) {
    if (!shouldGenerate(method)) {
      continue;
    }

    const path = openApiPath(method.path);
    const pathItem = paths[path] ?? {};
    pathItem[method.httpMethod.toLowerCase()] = openApiOperation(
      method,
      errorSchemaName,
    );
    paths[path] = pathItem;
    methodSchemaRefs(method, refs);
  }

  for (const child of Object.values(resource.resources ?? {})) {
    collectMethods(child, paths, refs, shouldGenerate, errorSchemaName);
  }
};

const discoveryErrorSchemaName = (discovery: DiscoveryDocument) => {
  if (discovery.schemas?.GoogleRpcStatus) {
    return "GoogleRpcStatus";
  }
  if (discovery.schemas?.Status) {
    return "Status";
  }
  return "GoogleRpcStatus";
};

const discoveryToOpenApi = (
  discovery: DiscoveryDocument,
  shouldGenerate: (method: DiscoveryMethod) => boolean,
) => {
  const paths: Record<string, Record<string, unknown>> = {};
  const refs = new Set<string>();
  const errorSchemaName = discoveryErrorSchemaName(discovery);
  refs.add(errorSchemaName);

  for (const resource of Object.values(discovery.resources ?? {})) {
    collectMethods(resource, paths, refs, shouldGenerate, errorSchemaName);
  }

  const schemas = transitiveSchemas(discovery.schemas ?? {}, refs);

  return {
    openapi: "3.0.3",
    info: {
      title: discovery.title ?? "Cloud Run Admin API",
      version: discovery.version,
    },
    servers: [
      {
        url:
          discovery.baseUrl ??
          discovery.rootUrl ??
          "https://run.googleapis.com/",
      },
    ],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [
          name,
          discoverySchemaToOpenApi(schema),
        ]),
      ),
    },
  };
};

const discoveryDocumentSchema = z
  .object({
    version: z.string(),
  })
  .passthrough();

const isDiscoveryDocument = (value: unknown): value is DiscoveryDocument =>
  discoveryDocumentSchema.safeParse(value).success;

const fetchDiscovery = async (name: string, url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch ${name} discovery document: ${response.status}`,
    );
  }
  const discovery: unknown = await response.json();
  if (!isDiscoveryDocument(discovery)) {
    throw new Error(`failed to parse ${name} discovery document`);
  }
  return discovery;
};

const azureOpenAICompatibleModelsOpenApi = {
  openapi: "3.0.3",
  info: {
    title: "Azure Foundry OpenAI-Compatible Models API",
    version: "2024-10-21",
  },
  servers: [
    {
      url: "",
    },
  ],
  paths: {
    "/openai/models": {
      get: {
        operationId: "azureFoundryOpenAICompatibleModelsList",
        description:
          "Gets a list of models exposed through an Azure Foundry OpenAI-compatible route.",
        parameters: [
          {
            name: "api-version",
            in: "query",
            required: true,
            schema: {
              type: "string",
              default: "2024-10-21",
            },
          },
        ],
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ModelList",
                },
              },
            },
          },
          default: {
            description: "An error occurred.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Capabilities: {
        type: "object",
        properties: {
          fine_tune: { type: "boolean" },
          inference: { type: "boolean" },
          completion: { type: "boolean" },
          chat_completion: { type: "boolean" },
          embeddings: { type: "boolean" },
        },
      },
      Deprecation: {
        type: "object",
        properties: {
          fine_tune: {
            type: "integer",
            format: "unixtime",
            nullable: true,
          },
          inference: {
            type: "integer",
            format: "unixtime",
          },
        },
      },
      Model: {
        type: "object",
        properties: {
          id: { type: "string" },
          object: { $ref: "#/components/schemas/TypeDiscriminator" },
          created_at: {
            type: "integer",
            format: "unixtime",
          },
          status: { $ref: "#/components/schemas/FineTuningState" },
          model: {
            type: "string",
            nullable: true,
          },
          fine_tune: {
            type: "string",
            nullable: true,
          },
          capabilities: { $ref: "#/components/schemas/Capabilities" },
          lifecycle_status: { $ref: "#/components/schemas/LifeCycleStatus" },
          deprecation: { $ref: "#/components/schemas/Deprecation" },
        },
      },
      ModelList: {
        type: "object",
        properties: {
          object: { $ref: "#/components/schemas/TypeDiscriminator" },
          data: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Model",
            },
          },
        },
      },
      Error: {
        type: "object",
        properties: {
          code: { $ref: "#/components/schemas/ErrorCode" },
          message: {
            type: "string",
            minLength: 1,
          },
          target: { type: "string" },
          details: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Error",
            },
          },
          innererror: { $ref: "#/components/schemas/InnerError" },
        },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: { $ref: "#/components/schemas/Error" },
        },
      },
      InnerError: {
        type: "object",
        properties: {
          code: { $ref: "#/components/schemas/InnerErrorCode" },
          innererror: { $ref: "#/components/schemas/InnerError" },
        },
      },
      ErrorCode: {
        type: "string",
        enum: [
          "conflict",
          "invalidPayload",
          "forbidden",
          "notFound",
          "unexpectedEntityState",
          "itemDoesAlreadyExist",
          "serviceUnavailable",
          "internalFailure",
          "quotaExceeded",
          "jsonlValidationFailed",
          "fileImportFailed",
          "tooManyRequests",
          "unauthorized",
          "contentFilter",
        ],
      },
      InnerErrorCode: {
        type: "string",
        enum: ["invalidPayload"],
      },
      FineTuningState: {
        type: "string",
        enum: [
          "created",
          "pending",
          "running",
          "succeeded",
          "cancelled",
          "failed",
        ],
      },
      LifeCycleStatus: {
        type: "string",
        enum: ["preview", "generally-available"],
      },
      TypeDiscriminator: {
        type: "string",
        enum: [
          "list",
          "fine_tuning.job",
          "file",
          "fine_tuning.job.event",
          "fine_tuning.job.checkpoint",
          "model",
          "batch",
          "upload",
          "upload.part",
        ],
      },
    },
  },
};

const gcpRunDiscovery = await fetchDiscovery("Cloud Run", gcpRunDiscoveryUrl);

await Bun.write(
  "openapi/gcp/run/v2/discovery.json",
  `${JSON.stringify(gcpRunDiscovery, null, 2)}\n`,
);

await Bun.write(
  "openapi/gcp/run/v2/openapi.json",
  `${JSON.stringify(
    discoveryToOpenApi(gcpRunDiscovery, shouldGenerateGcpRunMethod),
    null,
    2,
  )}\n`,
);

await Bun.write(
  "openapi/gcp/run/v2/jobs.openapi.json",
  `${JSON.stringify(
    discoveryToOpenApi(gcpRunDiscovery, shouldGenerateGcpRunJobMethod),
    null,
    2,
  )}\n`,
);

const gcpSecretManagerDiscovery = await fetchDiscovery(
  "Secret Manager",
  gcpSecretManagerDiscoveryUrl,
);

await Bun.write(
  "openapi/gcp/secretmanager/v1/discovery.json",
  `${JSON.stringify(gcpSecretManagerDiscovery, null, 2)}\n`,
);

await Bun.write(
  "openapi/gcp/secretmanager/v1/openapi.json",
  `${JSON.stringify(
    discoveryToOpenApi(
      gcpSecretManagerDiscovery,
      shouldGenerateGcpSecretManagerMethod,
    ),
    null,
    2,
  )}\n`,
);

const gcpAiplatformDiscovery = await fetchDiscovery(
  "Vertex AI",
  gcpAiplatformDiscoveryUrl,
);

await Bun.write(
  "openapi/gcp/aiplatform/v1beta1/discovery.json",
  `${JSON.stringify(gcpAiplatformDiscovery, null, 2)}\n`,
);

await Bun.write(
  "openapi/gcp/aiplatform/v1beta1/openapi.json",
  `${JSON.stringify(
    discoveryToOpenApi(
      gcpAiplatformDiscovery,
      shouldGenerateGcpAiplatformMethod,
    ),
    null,
    2,
  )}\n`,
);

await Bun.write(
  "openapi/azure/openai/2024-10-21/models.json",
  `${JSON.stringify(azureOpenAICompatibleModelsOpenApi, null, 2)}\n`,
);
