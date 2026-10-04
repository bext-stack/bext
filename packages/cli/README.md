# @bext-stack/cli

Install the Bext engine with its matching PRISM framework and TypeScript compiler:

```sh
npm install -g @bext-stack/cli
bext --version
bext dev ./my-site
```

`npx @bext-stack/cli --help` and `bunx @bext-stack/cli --help` also work.
The first invocation downloads the versioned Linux x64 engine from
`get.bext.dev`, decompresses it, verifies SHA256, and stores it under
`~/.cache/bext-stack-cli/<version>/`. Subsequent invocations reuse that file.
An npm postinstall hook prefetches it when package scripts are enabled.

Bext 0.2.11 is paired with `@bext-stack/framework` 0.2.0 and
`@bext-stack/tsc-rs` 0.4.2 through exact npm dependencies. The CLI sets their
runtime paths when it invokes the engine. This release supports Linux x64
with glibc 2.31 or newer; other builds are listed on the
[installation page](https://docs.bext.dev/getting-started/installation).

Overrides:

- `BEXT_CLI_BINARY=/path/to/bext` uses an existing executable.
- `BEXT_CLI_CACHE_DIR=/path` selects the download cache.
- `BEXT_CLI_SKIP_DOWNLOAD=1` skips postinstall prefetching.
- `TSCRS_PATH` and `BEXT_SHARED_FRAMEWORK_DIR` select custom compiler/framework paths.

[Documentation](https://docs.bext.dev/) · [Releases](https://github.com/bext-stack/bext/releases)

MIT.

Bext 0.2.11 fixes standalone PRISM route discovery and automatically reloads added, edited, and removed routes during development.
