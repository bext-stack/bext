<h1 align="center">bext</h1>

<p align="center">
  <strong>A self-hostable application platform written in Rust.</strong><br>
  High-performance HTTP, SSR, TLS, WAF, and a drop-in nginx replacement — all in one binary.
</p>

<p align="center">
  <a href="https://crates.io/crates/bext-plugin-api"><img alt="crates.io" src="https://img.shields.io/crates/v/bext-plugin-api?label=crates.io%20plugin-api&color=blue"></a>
  <a href="https://www.npmjs.com/package/@bext-stack/runtime"><img alt="npm" src="https://img.shields.io/npm/v/@bext-stack/runtime?label=npm&color=red"></a>
  <a href="https://github.com/bext-stack/bext/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT%20%2B%20BUSL--1.1-blueviolet"></a>
  <a href="https://github.com/bext-stack/bext/pkgs/container/bext"><img alt="GHCR" src="https://img.shields.io/badge/ghcr.io-bext--stack%2Fbext-black"></a>
</p>

## What is bext?

bext is a batteries-included HTTP server framework built on Bun and Rust. It
gives you the power of a full platform — routing, TLS, caching, SSR, real-time,
WAF, nginx compatibility, multi-app hosting — in a single self-hosted binary.

- **One binary, one config.** No Docker, no Kubernetes, no reverse proxy. Drop a
  `bext.config.toml` next to your app and `bext run`.
- **Drop-in nginx replacement.** Point bext at your existing `nginx.conf` and it
  just works. 68/70 directives supported.
- **Blazing fast SSR.** Embedded V8 and JavaScriptCore engines render pages at
  50K+ req/s with ISR caching.
- **Multi-app platform.** Host multiple apps on one server with hostname-based
  routing, deploy pipelines, rollbacks, and per-app cache isolation.
- **Rust plugins.** The whole runtime is modular — TLS, WAF, real-time, PHP-FPM,
  eBPF, nginx-compat, V8 — each is a standalone crate you can depend on a la carte.
- **Production tested.** Runs real customer traffic on the
  [activ-2](https://github.com/bext-stack/bext/issues) production stack with
  FastCGI, TLS, HTTP/2, SSR, and dozens of tenants.

## Install

### Bun app (the fast path)

```bash
bun add @bext-stack/runtime
bunx bext run
```

This installs the napi-linked Rust core. bext auto-detects Next.js, Hono,
Express, Laravel, Symfony, and plain static sites.

### Rust plugin author

```toml
[dependencies]
bext-plugin-api = "0.2"
```

```rust
use bext_plugin_api::{Plugin, Request, Response};

pub struct HelloPlugin;

impl Plugin for HelloPlugin {
    fn on_request(&self, req: &Request) -> Option<Response> {
        Some(Response::text(200, "Hello from bext"))
    }
}
```

### Drop-in nginx replacement

```bash
cargo install bext-nginx-shim
sudo mv /usr/sbin/nginx /usr/sbin/nginx.real
sudo ln -s $(which bext-nginx-shim) /usr/sbin/nginx
sudo systemctl reload nginx   # now reloads bext
```

### Container

```bash
docker pull ghcr.io/bext-stack/bext:latest
docker run -p 443:443 -v $PWD/bext.config.toml:/etc/bext/bext.config.toml ghcr.io/bext-stack/bext:latest
```

## Ecosystem at a glance

bext ships as a constellation of independently-versioned crates. Depend on
only what you need.

### Commercial engine (BUSL-1.1, converts to MIT on 2030-04-11)

| Crate | Purpose |
| --- | --- |
| [`bext-core`](https://crates.io/crates/bext-core) | Routing, SSR, caching, flow engine — the heart of bext |
| [`bext-plugin`](https://crates.io/crates/bext-plugin) | Plugin orchestration and lifecycle |
| [`bext-v8`](https://crates.io/crates/bext-v8) | V8 SSR eval engine with heap snapshots (~1ms startup) |
| [`bext-server`](https://crates.io/crates/bext-server) | HTTP server runtime and vhost dispatcher |

### Commercial product crates (BUSL-1.1)

| Crate | Purpose |
| --- | --- |
| [`bext-waf`](https://crates.io/crates/bext-waf) | Web Application Firewall — rate limiting, GeoIP, SQLi/XSS detection |
| [`bext-tls`](https://crates.io/crates/bext-tls) | TLS termination with automatic ACME certificate issuance |
| [`bext-nginx-compat`](https://crates.io/crates/bext-nginx-compat) | Nginx config parser and converter — drop-in nginx replacement |
| [`bext-nginx-shim`](https://crates.io/crates/bext-nginx-shim) | Drop-in `nginx` binary that translates the nginx CLI to bext operations |

### Plugin ecosystem (MIT — free for anyone to extend)

| Crate | Purpose |
| --- | --- |
| [`bext-plugin-api`](https://crates.io/crates/bext-plugin-api) | Public ABI for third-party plugin authors |
| [`bext-plugin-wasm`](https://crates.io/crates/bext-plugin-wasm) | WASM plugin host (wasmtime) with fuel budgets and KV store |
| [`bext-plugin-quickjs`](https://crates.io/crates/bext-plugin-quickjs) | JavaScript plugin sandbox (QuickJS) |
| [`bext-plugin-nsjail`](https://crates.io/crates/bext-plugin-nsjail) | Process-isolated plugin host (nsjail, Linux only) |

### Utilities (MIT)

| Crate | Purpose |
| --- | --- |
| [`bext-realtime`](https://crates.io/crates/bext-realtime) | WebSocket and SSE pub/sub with optional Redis relay |
| [`bext-ebpf`](https://crates.io/crates/bext-ebpf) | eBPF acceleration — XDP filtering, uprobe tracing, seccomp |
| [`bext-php`](https://crates.io/crates/bext-php) | Embedded PHP runtime via custom SAPI |
| [`bext-css`](https://crates.io/crates/bext-css) | Rust-native Tailwind v4 generator |
| [`bext-tui`](https://crates.io/crates/bext-tui) | Terminal management dashboard (ratatui) |

### npm packages (MIT)

| Package | Purpose |
| --- | --- |
| [`@bext-stack/runtime`](https://www.npmjs.com/package/@bext-stack/runtime) | Main Bun runtime with napi-linked Rust core |
| [`@bext-stack/platform`](https://www.npmjs.com/package/@bext-stack/platform) | Platform SDK: KV, queue, cache, realtime, scheduler |
| [`@bext-stack/t3-provider`](https://www.npmjs.com/package/@bext-stack/t3-provider) | t3code deployment provider adapter |

## Licensing

bext ships under a **split license** designed to be permissive for developers
while discouraging rebundling by competing managed-service providers.

**MIT** — the entire plugin ecosystem, utilities, wrappers, and SDKs. Use them
freely in any context including closed-source commercial products.

**Business Source License 1.1** (converts to MIT on **2030-04-11**) — the
commercial engine (`bext-core`, `bext-plugin`, `bext-v8`, `bext-server`) and
the standalone product crates (`bext-waf`, `bext-tls`, `bext-nginx-compat`,
`bext-nginx-shim`).

Under BSL, **production use on your own infrastructure is fully permitted**.
The only thing you cannot do is offer these crates to third parties as a
hosted or managed service providing substantial feature access. On the
Change Date (2030-04-11) the BSL crates automatically convert to MIT with
no further restrictions.

Full text in [LICENSE](LICENSE) at the repo root and in each BSL crate's
`LICENSE.md`.

## Performance

Measured with autocannon, 10 seconds per route, single machine. Values are
requests per second.

| Route | bext-server | bext ISR (Bun) | React renderToString | Vue 3 SSR | Next.js | Speedup vs React |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| /simple | **52,688** | 11,104 | 9,504 | 9,204 | 10,004 | **5.5x** |
| /dashboard | **51,350** | 12,177 | 7,651 | 7,651 | 7,952 | **6.7x** |
| /table/50 | **41,994** | 37,811 | 1,276 | 1,946 | 1,352 | **32.9x** |
| /table/200 | **27,712** | 37,462 | 346 | 536 | 370 | **80.1x** |
| /full-page | **44,842** | 12,028 | 2,126 | 2,876 | 2,201 | **21.1x** |

bext-server numbers reflect ISR-cached responses served entirely from Rust.
bext ISR (Bun) numbers reflect the napi plugin serving cached pages through
Bun's event loop.

## Documentation

- **Quickstart**: [bext-stack.github.io/docs/quickstart](https://bext-stack.github.io/docs/quickstart)
- **Platform overview**: [bext-stack.github.io/docs/platform](https://bext-stack.github.io/docs/platform)
- **Plugin authoring**: [bext-stack.github.io/docs/plugins](https://bext-stack.github.io/docs/plugins)
- **Config reference**: [bext-stack.github.io/docs/config](https://bext-stack.github.io/docs/config)
- **nginx migration**: [bext-stack.github.io/docs/nginx-compat](https://bext-stack.github.io/docs/nginx-compat)
- **Architecture**: [bext-stack.github.io/docs/architecture](https://bext-stack.github.io/docs/architecture)
- **Examples**: [github.com/bext-stack/examples](https://github.com/bext-stack/examples)

## Source layout

bext is developed in a private monorepo. This repo is the public home for
docs, examples, issues, and release notes. Published artifacts are pushed
here from the monorepo's CI on every tagged release.

Selected crates with external contributor interest have their own read-only
mirror repos, maintained via `git subtree split`:

- [`bext-plugin-api`](https://github.com/bext-stack/bext-plugin-api) — plugin
  ABI crate, primary audience is plugin authors
- [`bext-nginx-compat`](https://github.com/bext-stack/bext-nginx-compat) —
  nginx config parser and drop-in replacement

## Community and support

- **Bug reports**: use the [issue tracker](https://github.com/bext-stack/bext/issues)
  on this repo. Template issues for bug / feature / plugin-api / security.
- **Security**: see [SECURITY.md](SECURITY.md) — please report privately, not
  via public issues.
- **Discussions**: enable once there's traffic.
- **Contributing**: see [CONTRIBUTING.md](CONTRIBUTING.md). External patches
  come in via issue → replayed into the private monorepo → released here.
- **Commercial licensing / managed service inquiries**: open an issue tagged
  `licensing`.

## Status and roadmap

- **Phase 1 (now)**: 13 GREEN crates publishing to crates.io + npm.
- **Phase 1.5**: unblock `bext-core`, `bext-plugin`, `bext-v8` by publishing the
  tsc-rs dependency chain. Publish the 8 `bext-impls/*` plugin implementations.
- **Phase 2**: docs site and curated examples repo.
- **Phase 3**: `bext-server`, `bext-turbopack`, `bext-react-compiler` unblock
  once their vendored upstream deps reach crates.io.
- **Phase 4**: 1.0, independent semver per crate, LTS consideration.

See [plan/bext-stack-org/05-milestones.md](https://github.com/bext-stack/bext/blob/main/plan/bext-stack-org/05-milestones.md)
in the monorepo for the detailed plan.
