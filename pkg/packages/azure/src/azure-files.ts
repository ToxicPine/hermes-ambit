import { Effect } from "effect";

import {
  HERMES_DATA_MOUNT_PATH,
  OperationFailed,
  invokeHttp,
  type CloudError,
  type UserVolumeService,
} from "@cardelli/shared";

import type { ManagedEnvironmentStorage } from "./generated/managed-environment-storages/model/managedEnvironmentStorage";
import type { AzureAccessToken, AzureAuthContext } from "./client.js";
import {
  getManagedEnvironmentStorage,
  type AzureManagedEnvironmentStorageRef,
} from "./environment-storage.js";

export type AzureFileShareRef = {
  readonly accountName: string;
  readonly shareName: string;
};

type AzureFileRef = AzureFileShareRef & {
  readonly path: string;
};

type AzureDirectoryEntry =
  | { readonly kind: "file"; readonly name: string }
  | { readonly kind: "directory"; readonly name: string };

const AZURE_FILES_REST_VERSION = "2025-05-05";
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

const azureFileShareFromManagedEnvironmentStorage = (
  storage: ManagedEnvironmentStorage,
): AzureFileShareRef | undefined => {
  const azureFile = storage.properties?.azureFile;
  return azureFile?.accountName && azureFile.shareName
    ? {
        accountName: azureFile.accountName,
        shareName: azureFile.shareName,
      }
    : undefined;
};

export const getAzureFileShareForManagedEnvironmentStorage = (
  auth: AzureAuthContext,
  ref: AzureManagedEnvironmentStorageRef,
): Effect.Effect<AzureFileShareRef, CloudError> =>
  Effect.gen(function* () {
    const storage = yield* getManagedEnvironmentStorage(auth, ref);
    const share = azureFileShareFromManagedEnvironmentStorage(storage.data);
    return share
      ? share
      : yield* Effect.fail(
          new OperationFailed({
            operation: "azure.managedEnvironments.storages.azureFile",
            message:
              "Managed environment storage does not expose Azure Files account and share names.",
            cause: storage.data,
          }),
        );
  });

const normalizePath = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");

const encodePath = (path: string): string =>
  normalizePath(path).split("/").map(encodeURIComponent).join("/");

const azureFileUrl = (file: AzureFileRef, query?: string): string => {
  const path = encodePath(file.path);
  const suffix = query ? `?${query}` : "";
  return `https://${file.accountName}.file.core.windows.net/${encodeURIComponent(
    file.shareName,
  )}/${path}${suffix}`;
};

const azureFileHeaders = (
  token: AzureAccessToken,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${token.accessToken}`,
  "x-ms-date": new Date().toUTCString(),
  "x-ms-file-request-intent": "backup",
  "x-ms-version": AZURE_FILES_REST_VERSION,
  ...extra,
});

const successStatus = (status: number): boolean =>
  status >= 200 && status < 300;

const failAzureFileResponse = (
  operation: string,
  response: Response,
  body: string,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    new OperationFailed({
      operation,
      message: body.length > 0 ? body : `HTTP ${response.status}`,
      cause: {
        status: response.status,
        body,
      },
    }),
  );

const sendAzureFile = (
  auth: AzureAuthContext,
  operation: string,
  file: AzureFileRef,
  init: () => {
    readonly method: string;
    readonly query?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: BodyInit;
  },
): Effect.Effect<Response, CloudError> =>
  Effect.gen(function* () {
    const token = yield* auth.token();
    const request = init();
    const headers = azureFileHeaders(token);
    return yield* invokeHttp(operation, () =>
      fetch(azureFileUrl(file, request.query), {
        method: request.method,
        headers: {
          ...headers,
          ...(request.headers ?? {}),
        },
        ...(request.body ? { body: request.body } : {}),
      }),
    );
  });

const azureFileResponseBody = (
  operation: string,
  response: Response,
): Effect.Effect<string, CloudError> =>
  invokeHttp(operation, () => response.text());

const readAzureFileText = (
  auth: AzureAuthContext,
  file: AzureFileRef,
): Effect.Effect<string, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.files.get";
    const response = yield* sendAzureFile(auth, operation, file, () => ({
      method: "GET",
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
    return body;
  });

const readAzureFileTextIfExists = (
  auth: AzureAuthContext,
  file: AzureFileRef,
): Effect.Effect<string | undefined, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.files.get";
    const response = yield* sendAzureFile(auth, operation, file, () => ({
      method: "GET",
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (response.status === 404) {
      return undefined;
    }
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
    return body;
  });

const createAzureFile = (
  auth: AzureAuthContext,
  file: AzureFileRef,
  byteLength: number,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.files.create";
    const response = yield* sendAzureFile(auth, operation, file, () => ({
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Type": "text/plain; charset=utf-8",
        "x-ms-content-length": String(byteLength),
        "x-ms-type": "file",
      },
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
  });

const createAzureDirectory = (
  auth: AzureAuthContext,
  directory: AzureFileRef,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const path = normalizePath(directory.path);
    if (!path) return;

    const operation = "azure.files.createDirectory";
    const response = yield* sendAzureFile(
      auth,
      operation,
      { ...directory, path },
      () => ({
        method: "PUT",
        query: "restype=directory",
        headers: {
          "Content-Length": "0",
        },
      }),
    );
    const body = yield* azureFileResponseBody(operation, response);
    if (response.status === 409) {
      return;
    }
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
  });

const parentDirectories = (path: string): readonly string[] => {
  const segments = normalizePath(path).split("/").filter(Boolean);
  return segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"));
};

const ensureAzureFileParentDirectories = (
  auth: AzureAuthContext,
  file: AzureFileRef,
): Effect.Effect<void, CloudError> =>
  Effect.forEach(
    parentDirectories(file.path),
    (path) => createAzureDirectory(auth, { ...file, path }),
    { discard: true },
  );

const putAzureFileRange = (
  auth: AzureAuthContext,
  file: AzureFileRef,
  bytes: Uint8Array,
  start: number,
  end: number,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.files.putRange";
    const chunk = bytes.slice(start, end + 1);
    const response = yield* sendAzureFile(auth, operation, file, () => ({
      method: "PUT",
      query: "comp=range",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Type": "text/plain; charset=utf-8",
        "x-ms-range": `bytes=${start}-${end}`,
        "x-ms-write": "update",
      },
      body: chunk,
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
  });

const putAzureFileRanges = (
  auth: AzureAuthContext,
  file: AzureFileRef,
  bytes: Uint8Array,
  start: number,
): Effect.Effect<void, CloudError> => {
  if (start >= bytes.byteLength) {
    return Effect.void;
  }

  const end = Math.min(start + MAX_RANGE_BYTES, bytes.byteLength) - 1;
  return Effect.gen(function* () {
    yield* putAzureFileRange(auth, file, bytes, start, end);
    return yield* putAzureFileRanges(auth, file, bytes, end + 1);
  });
};

const writeAzureFileText = (
  auth: AzureAuthContext,
  file: AzureFileRef,
  contents: string,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(contents);
    yield* ensureAzureFileParentDirectories(auth, file);
    yield* createAzureFile(auth, file, bytes.byteLength);
    yield* putAzureFileRanges(auth, file, bytes, 0);
  });

const fileChild = (parent: AzureFileRef, name: string): AzureFileRef => ({
  ...parent,
  path: normalizePath(`${parent.path}/${name}`),
});

const deleteAzureFile = (
  auth: AzureAuthContext,
  file: AzureFileRef,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.files.deleteFile";
    const response = yield* sendAzureFile(auth, operation, file, () => ({
      method: "DELETE",
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (response.status === 404) {
      return;
    }
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
  });

const deleteAzureDirectory = (
  auth: AzureAuthContext,
  directory: AzureFileRef,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const operation = "azure.files.deleteDirectory";
    const response = yield* sendAzureFile(auth, operation, directory, () => ({
      method: "DELETE",
      query: "restype=directory",
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (response.status === 404) {
      return;
    }
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
  });

const decodeAzureListedName = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

const firstElementText = (
  element: Element,
  tagName: string,
): string | undefined =>
  element.getElementsByTagName(tagName).item(0)?.textContent ?? undefined;

const parseAzureDirectoryEntries = (
  body: string,
): Effect.Effect<
  {
    readonly entries: readonly AzureDirectoryEntry[];
    readonly nextMarker?: string;
  },
  OperationFailed
> => {
  const document = new DOMParser().parseFromString(body, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    return Effect.fail(
      new OperationFailed({
        operation: "azure.files.listDirectory.parse",
        message: "Azure Files returned malformed directory listing XML.",
      }),
    );
  }

  const entriesElement = document.getElementsByTagName("Entries").item(0);
  const entries: readonly AzureDirectoryEntry[] = entriesElement
    ? Array.from(entriesElement.children).reduce<
        readonly AzureDirectoryEntry[]
      >((acc, entry) => {
        const name = firstElementText(entry, "Name");
        if (!name) return acc;
        if (entry.tagName === "File") {
          const file: AzureDirectoryEntry = {
            kind: "file",
            name: decodeAzureListedName(name),
          };
          return [...acc, file];
        }
        if (entry.tagName === "Directory") {
          const directory: AzureDirectoryEntry = {
            kind: "directory",
            name: decodeAzureListedName(name),
          };
          return [...acc, directory];
        }
        return acc;
      }, [])
    : [];
  const nextMarker = firstElementText(document.documentElement, "NextMarker");

  return Effect.succeed({
    entries,
    ...(nextMarker ? { nextMarker } : {}),
  });
};

const listAzureDirectoryPage = (
  auth: AzureAuthContext,
  directory: AzureFileRef,
  marker?: string,
): Effect.Effect<
  {
    readonly entries: readonly AzureDirectoryEntry[];
    readonly nextMarker?: string;
  },
  CloudError
> =>
  Effect.gen(function* () {
    const operation = "azure.files.listDirectory";
    const query = new URLSearchParams({
      restype: "directory",
      comp: "list",
      ...(marker ? { marker } : {}),
    });
    const response = yield* sendAzureFile(auth, operation, directory, () => ({
      method: "GET",
      query: query.toString(),
    }));
    const body = yield* azureFileResponseBody(operation, response);
    if (response.status === 404) {
      return { entries: [] };
    }
    if (!successStatus(response.status)) {
      return yield* failAzureFileResponse(operation, response, body);
    }
    return yield* parseAzureDirectoryEntries(body);
  });

const collectAzureDirectoryEntries = (
  auth: AzureAuthContext,
  directory: AzureFileRef,
  marker: string | undefined,
  entries: readonly AzureDirectoryEntry[],
): Effect.Effect<readonly AzureDirectoryEntry[], CloudError> =>
  Effect.gen(function* () {
    const page = yield* listAzureDirectoryPage(auth, directory, marker);
    const next = [...entries, ...page.entries];
    return page.nextMarker
      ? yield* collectAzureDirectoryEntries(
          auth,
          directory,
          page.nextMarker,
          next,
        )
      : next;
  });

const deleteAzureDirectoryContents = (
  auth: AzureAuthContext,
  directory: AzureFileRef,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const entries = yield* collectAzureDirectoryEntries(
      auth,
      directory,
      undefined,
      [],
    );
    yield* deleteAzureDirectoryEntries(auth, directory, entries);
  });

const deleteAzureDirectoryEntries = (
  auth: AzureAuthContext,
  parent: AzureFileRef,
  entries: readonly AzureDirectoryEntry[],
): Effect.Effect<void, CloudError> => {
  const [entry, ...rest] = entries;
  if (!entry) return Effect.void;

  return Effect.gen(function* () {
    const child = fileChild(parent, entry.name);
    if (entry.kind === "directory") {
      yield* deleteAzureDirectoryContents(auth, child);
      yield* deleteAzureDirectory(auth, child);
    } else {
      yield* deleteAzureFile(auth, child);
    }
    return yield* deleteAzureDirectoryEntries(auth, parent, rest);
  });
};

export const clearAzureDirectory = (
  auth: AzureAuthContext,
  directory: AzureFileRef,
): Effect.Effect<void, CloudError> => {
  const path = normalizePath(directory.path);
  if (!path) {
    return Effect.fail(
      new OperationFailed({
        operation: "azure.files.clearDirectory",
        message: "Refusing to clear the root of an Azure file share.",
      }),
    );
  }

  return deleteAzureDirectoryContents(auth, { ...directory, path });
};

const dataVolumePath = (
  dataSubPath: string,
  path: string,
): Effect.Effect<string, OperationFailed> => {
  const prefix = `${HERMES_DATA_MOUNT_PATH}/`;
  if (!path.startsWith(prefix)) {
    return Effect.fail(
      new OperationFailed({
        operation: "azure.files.userVolume.path",
        message: `Azure Files user volume can only address paths under ${HERMES_DATA_MOUNT_PATH}.`,
      }),
    );
  }

  return Effect.succeed(
    normalizePath(`${dataSubPath}/${path.slice(prefix.length)}`),
  );
};

export const makeAzureFilesUserVolume = (
  auth: AzureAuthContext,
  share: AzureFileShareRef,
  dataSubPath: string,
): UserVolumeService => ({
  readText: (path) =>
    Effect.gen(function* () {
      const filePath = yield* dataVolumePath(dataSubPath, path);
      return yield* readAzureFileText(auth, { ...share, path: filePath });
    }),
  readTextIfExists: (path) =>
    Effect.gen(function* () {
      const filePath = yield* dataVolumePath(dataSubPath, path);
      return yield* readAzureFileTextIfExists(auth, {
        ...share,
        path: filePath,
      });
    }),
  writeText: (path, contents) =>
    Effect.gen(function* () {
      const filePath = yield* dataVolumePath(dataSubPath, path);
      yield* writeAzureFileText(auth, { ...share, path: filePath }, contents);
    }),
});
