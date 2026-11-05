#!/usr/bin/env node
import { main, nodeIo } from "./cli.js";

main(process.argv.slice(2), nodeIo()).then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write(`nooscape-verify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
);
