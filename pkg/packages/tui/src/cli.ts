#!/usr/bin/env bun
import { runCli } from "./cli-runtime.js";

runCli().catch((error: unknown) => {
  throw error;
});
