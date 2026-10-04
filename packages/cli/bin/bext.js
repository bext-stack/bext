#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { ensureBinary, log } = require("../scripts/runtime.js");

(async () => {
  try {
    const binary = await ensureBinary();
    const { resolveBinaryPath } = await import(pathToFileURL(require.resolve("@bext-stack/tsc-rs/lib/resolve.mjs")));
    const framework = path.dirname(require.resolve("@bext-stack/framework/jsx"));
    const env = { ...process.env,
      TSCRS_PATH: process.env.TSCRS_PATH || resolveBinaryPath(),
      BEXT_SHARED_FRAMEWORK_DIR: process.env.BEXT_SHARED_FRAMEWORK_DIR || framework,
    };
    const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", env });
    if (result.error) throw result.error;
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exit(result.status ?? 1);
  } catch (error) {
    log(error.message);
    process.exit(1);
  }
})();
