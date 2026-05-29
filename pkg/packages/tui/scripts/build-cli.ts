import { chmod, mkdir } from "node:fs/promises";

import solidPlugin from "@opentui/solid/bun-plugin";

type CliBuild = {
  readonly entrypoint: string;
  readonly outfile: string;
};

type BuildLog = {
  readonly level: string;
  readonly message: string;
};

const builds: readonly CliBuild[] = [
  {
    entrypoint: "packages/tui/src/cli.ts",
    outfile: "dist-bin/hermes-ambit.js",
  },
  {
    entrypoint: "packages/tui/src/cli-gcp.ts",
    outfile: "dist-bin/hermes-ambit-gcp.js",
  },
  {
    entrypoint: "packages/tui/src/cli-azure.ts",
    outfile: "dist-bin/hermes-ambit-azure.js",
  },
];

const logMessage = (log: BuildLog): string =>
  `${log.level.toUpperCase()}: ${log.message}`;

const buildCli = async (input: CliBuild): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [input.entrypoint],
    target: "bun",
    minify: true,
    write: false,
    plugins: [solidPlugin],
  });

  for (const log of result.logs) {
    console.error(logMessage(log));
  }

  if (!result.success) {
    throw new Error(`Could not build ${input.outfile}.`);
  }

  const output = result.outputs[0];
  if (!output) {
    throw new Error(`Build did not produce ${input.outfile}.`);
  }

  await Bun.write(input.outfile, output);
  await chmod(input.outfile, 0o755);
};

await mkdir("dist-bin", { recursive: true });

for (const build of builds) {
  await buildCli(build);
}
