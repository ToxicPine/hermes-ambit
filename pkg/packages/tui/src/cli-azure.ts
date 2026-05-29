#!/usr/bin/env bun
import { runCli } from "./cli-runtime.js";

runCli("azure").catch((error: unknown) => {
  throw error;
});
