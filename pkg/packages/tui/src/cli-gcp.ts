#!/usr/bin/env bun
import { runCli } from "./cli-runtime.js";

runCli("gcp").catch((error: unknown) => {
  throw error;
});
