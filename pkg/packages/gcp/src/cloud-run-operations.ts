import { Effect } from "effect";

import {
  OperationFailed,
  emitCloudEvent,
  type CloudError,
} from "@cardelli/shared";

import { waitCloudRunOperation } from "./cloud-run.js";
import type { GcpAuthContext } from "./client.js";
import type { GoogleLongrunningOperation } from "./generated/run/model/googleLongrunningOperation";
import type { GoogleRpcStatus } from "./generated/run/model/googleRpcStatus";

const operationFailed = (
  operation: string,
  message: string,
  cause?: unknown,
): Effect.Effect<never, OperationFailed> =>
  Effect.fail(
    cause === undefined
      ? new OperationFailed({ operation, message })
      : new OperationFailed({ operation, message, cause }),
  );

const rpcStatusMessage = (status: GoogleRpcStatus) =>
  status.message && status.message.length > 0
    ? status.message
    : "Cloud Run operation failed";

const failCompletedOperation = (
  operation: string,
  status: GoogleRpcStatus,
) => operationFailed(operation, rpcStatusMessage(status), status);

const waitForCloudRunOperation = (
  auth: GcpAuthContext,
  ref: { readonly name: string },
  remainingAttempts = 30,
): Effect.Effect<void, CloudError> =>
  Effect.gen(function* () {
    const waited = yield* waitCloudRunOperation(auth, ref, { timeout: "30s" });

    if (waited.data.error) {
      return yield* failCompletedOperation(
        "gcp.run.operations.wait",
        waited.data.error,
      );
    }
    if (waited.data.done !== true) {
      if (remainingAttempts <= 0) {
        return yield* operationFailed(
          "gcp.run.operations.wait",
          `Timed out waiting for ${ref.name}`,
        );
      }
      yield* Effect.sleep("2 seconds");
      return yield* waitForCloudRunOperation(auth, ref, remainingAttempts - 1);
    }
  });

export const waitForCloudRunMutation = (
  auth: GcpAuthContext,
  operation: string,
  mutation: GoogleLongrunningOperation,
) =>
  Effect.gen(function* () {
    if (mutation.error) {
      return yield* failCompletedOperation(operation, mutation.error);
    }
    if (mutation.done === true) {
      return;
    }
    if (!mutation.name) {
      return yield* operationFailed(
        operation,
        "Cloud Run mutation did not return an operation name",
        mutation,
      );
    }
    yield* emitCloudEvent({
      level: "info",
      scope: "provider",
      operation,
      resource: mutation.name,
      message: "Waiting for Cloud Run operation",
    });
    yield* waitForCloudRunOperation(auth, { name: mutation.name });
    yield* emitCloudEvent({
      level: "info",
      scope: "provider",
      operation,
      resource: mutation.name,
      message: "Cloud Run operation completed",
    });
  });
