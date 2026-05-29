import { Effect } from "effect";

export type ProviderOperationResult<TSummary> = {
  readonly summary: TSummary;
  readonly raw: unknown;
};

export const providerOperationResult = <TRaw, TSummary>(
  raw: TRaw,
  summarize: (raw: TRaw) => TSummary,
): ProviderOperationResult<TSummary> => ({
  summary: summarize(raw),
  raw,
});

export const mapProviderOperationResult = <TRaw, TSummary, E, R>(
  effect: Effect.Effect<TRaw, E, R>,
  summarize: (raw: TRaw) => TSummary,
): Effect.Effect<ProviderOperationResult<TSummary>, E, R> =>
  Effect.map(effect, (raw) => providerOperationResult(raw, summarize));
