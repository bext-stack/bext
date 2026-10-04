const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { createGunzip } = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { version } = require("../package.json");

const targets = { "linux:x64": "x86_64-unknown-linux-gnu" };
const log = message => process.stderr.write(`[@bext-stack/cli] ${message}\n`);

function response(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5 || new URL(url).protocol !== "https:") {
      return reject(new Error("Invalid release redirect"));
    }
    const request = https.get(url, { headers: { "User-Agent": `@bext-stack/cli ${version}` } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve(response(new URL(res.headers.location, url).href, redirects + 1));
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      } else resolve(res);
    });
    request.setTimeout(120000, () => request.destroy(new Error("Release download timed out")));
    request.on("error", reject);
  });
}

async function ensureBinary() {
  if (process.env.BEXT_CLI_BINARY) {
    const override = path.resolve(process.env.BEXT_CLI_BINARY);
    fs.accessSync(override, fs.constants.X_OK);
    return override;
  }
  const target = targets[`${process.platform}:${process.arch}`];
  if (!target) throw new Error(`Bext ${version} currently ships a Linux x64 build. See https://docs.bext.dev/getting-started/installation for other platforms.`);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cache = process.env.BEXT_CLI_CACHE_DIR || path.join(base, "bext-stack-cli", version);
  const binary = path.join(cache, "bext");
  if (fs.existsSync(binary)) return binary;
  fs.mkdirSync(cache, { recursive: true });
  const release = `https://get.bext.dev/bext-server/${version}`;
  const checksums = await response(`${release}/SHA256SUMS`);
  let text = "";
  for await (const chunk of checksums) {
    text += chunk;
    if (text.length > 65536) throw new Error("Unexpected checksum manifest size");
  }
  const entries = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === target);
  if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0][0])) throw new Error("Release checksum is missing or ambiguous");
  const temporary = path.join(cache, `.download-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    log(`Downloading Bext ${version} for ${target}`);
    await pipeline(await response(`${release}/${target}.gz`), createGunzip(), fs.createWriteStream(temporary, { flags: "wx", mode: 0o700 }));
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
    if (hash.digest("hex") !== entries[0][0]) throw new Error("Release checksum mismatch");
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, binary);
    return binary;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { ensureBinary, log };
