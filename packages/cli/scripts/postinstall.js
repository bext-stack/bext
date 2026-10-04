#!/usr/bin/env node
const { ensureBinary, log } = require("./runtime.js");
if (process.env.BEXT_CLI_SKIP_DOWNLOAD !== "1") {
  ensureBinary().catch(error => log(`Download deferred until first run: ${error.message}`));
}
