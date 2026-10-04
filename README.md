# Bext

Bext is a self-hosted Rust application engine with embedded V8, routing,
TLS, caching, and the PRISM server-first TSX framework.

The current public Linux x64 distribution pairs **Bext 0.2.11**, **tsc-rs
0.4.2**, and **PRISM (`@bext-stack/framework`) 0.2.0**. It requires glibc
2.31 or newer. The bundle includes the engine, native compiler, and framework
resources as one immutable release.

## Install

```sh
curl -fsSL https://bext.dev/install | sh
export PATH="$HOME/.local/bin:$PATH"
bext --version
tsc-rs --version
```

The installer verifies SHA256 before installing to `$XDG_BIN_HOME` or
`~/.local/bin`. Set `BEXT_INSTALL_DIR` to choose another directory, or
`BEXT_RELEASE_ID=20261004-bext-0.2.11-tsc-0.4.2` to pin this release.
It updates installed tools; deploying them to a running server is a separate
operation.

For Node.js 18+ on Linux x64:

```sh
npm install -g @bext-stack/cli@0.2.11
bext --version
```

The npm CLI downloads and verifies the versioned engine and depends on the
matching compiler and framework. To use those packages independently:

```sh
npm install @bext-stack/framework@0.2.0
npm install --save-dev @bext-stack/tsc-rs@0.4.2
npx tsc-rs --version
```

## Downloads and documentation

- [Bext 0.2.11 release and checksums](https://github.com/bext-stack/bext/releases/tag/v0.2.11)
- [Stable release manifest](https://get.bext.dev/latest.json)
- [Installation guide](https://docs.bext.dev/getting-started/installation)
- [PRISM quickstart](https://docs.bext.dev/getting-started/quickstart)
- [PRISM reference](https://docs.bext.dev/frameworks/prism)
- [tsc-rs source and platform releases](https://github.com/benfavre/ts-rs)
- [Compiler documentation and playground](https://ts-rs.bext.dev)

The Bext bundle currently supports Linux x64. Separate tsc-rs compiler
releases support Linux x64/ARM64, macOS Intel/Apple Silicon, and Windows x64.

## Public source

Bext is developed in a private monorepo. This public repository contains
release artifacts, issues, and the source distributed in the npm packages:

- [`sites/shared/framework`](sites/shared/framework) — PRISM framework 0.2.0,
  including its runtime modules and JSX declarations.
- [`packages/cli`](packages/cli) — Bext CLI 0.2.11 with checksum verification
  and exact compiler/framework dependencies.
- [`scripts/install.sh`](scripts/install.sh) — matched release installer.

The complete `bext-server` Cargo workspace is not in this repository.
Selected Rust SDK crates have separate repositories in the
[bext-stack organization](https://github.com/bext-stack).

## Verification and licensing

The release manifest records exact source revisions, toolchains, binary
SHA256 hashes, and the glibc baseline. The build gate checks a cold PRISM TSX
render, TypeScript imports, emitted JavaScript execution in V8, GET/POST API
handlers, static files, and 404 responses. PRISM 0.2.0 passed 503 framework
tests before publication.

See [LICENSE](LICENSE), each package's license, and the
[licensing documentation](https://docs.bext.dev/licensing/overview).
Report bugs in the [issue tracker](https://github.com/bext-stack/bext/issues).
For security reports, follow [SECURITY.md](SECURITY.md).
