import { Context, Effect, Layer } from "effect";

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
