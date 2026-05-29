import { Context, Effect, Layer, Option } from "effect";

export type CloudEvent = {
  readonly level: "debug" | "info" | "warn";
  readonly scope?: string;
  readonly operation?: string;
  readonly message: string;
  readonly resource?: string;
};

export class CloudLog extends Context.Tag("@cardelli/shared/CloudLog")<
  CloudLog,
  {
    readonly emit: (event: CloudEvent) => Effect.Effect<void>;
  }
>() {
  static readonly silent = Layer.succeed(CloudLog, {
    emit: () => Effect.void,
  });

  static readonly console = Layer.succeed(CloudLog, {
    emit: (event) =>
      Effect.sync(() => {
        const prefix = [
          event.level,
          event.scope,
          event.operation,
          event.resource,
        ]
          .filter(Boolean)
          .join(" ");
        console.error(prefix ? `${prefix}: ${event.message}` : event.message);
      }),
  });
}

export const emitCloudEvent = (event: CloudEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const logger = yield* Effect.serviceOption(CloudLog);
    return yield* Option.match(logger, {
      onNone: () => Effect.void,
      onSome: (log) => log.emit(event),
    });
  });
