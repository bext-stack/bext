# Security Policy

## Supported versions

bext is pre-1.0. Security fixes land on the latest published version (`0.2.x`
at time of writing). Older versions do not receive backports. If you're on an
older release, upgrade first and re-test before filing a report.

| Version | Supported |
| --- | --- |
| `0.2.x` | ✅ |
| `0.1.x` | ❌ |

## Reporting a vulnerability

**Please do not file public issues for security vulnerabilities.** Public
disclosure before a fix is available puts every bext user at risk.

### Preferred: GitHub Security Advisories

1. Go to <https://github.com/bext-stack/bext/security/advisories/new>
2. Fill out the template — be specific about affected crates, versions,
   reproducer, and impact.
3. GitHub will notify the maintainer and open a private discussion thread.

This channel is encrypted end-to-end between you and the maintainer, and
GitHub handles coordination with the CVE database once a fix ships.

### Alternative: email

If you can't use GitHub advisories, email **security@bext-stack.dev** with:

- Affected crate(s) and version(s)
- A minimal reproducer (ideally a `cargo test`-style POC)
- Your assessment of impact (auth bypass? RCE? DoS? information disclosure?)
- Whether you want public credit once disclosed
- Your preferred disclosure timeline

PGP is not required but welcomed. The key fingerprint will be published here
once a maintainer key is generated.

## What to expect

| Phase | Timeline | What happens |
| --- | ---: | --- |
| Acknowledgement | within 48 hours | You get a reply confirming receipt and a tracking ID |
| Triage | within 5 days | Severity assessment, affected-version analysis, CVSS score |
| Fix development | 1-30 days | Depends on complexity and severity |
| Coordinated disclosure | 90 days max | Public advisory + CVE + patched release |

For critical severity issues (auth bypass, RCE, data loss) we aim for a
patch within 7 days. For medium severity, 30 days. For low severity,
bundled into the next regular release.

## Scope

In scope:

- **All published bext crates** on crates.io and npm (the 13 phase-1 crates,
  and any crates added in phase 1.5 / phase 3).
- **Published container images** on GHCR (`ghcr.io/bext-stack/bext:*`).
- **Subtree mirror repos** (`bext-stack/bext-plugin-api`, `bext-stack/bext-nginx-compat`).

Out of scope:

- **Third-party plugins** that use `bext-plugin-api`. Report to the plugin
  author, not to us.
- **Vendored upstream dependencies** (turbopack, react-compiler, tsc_rs).
  Report to those projects directly.
- **Deployment misconfiguration** — if someone leaves their license key in
  a public bucket, that's not a bext vulnerability.
- **Social engineering** of maintainers or users.
- **Denial of service via resource exhaustion** unless it bypasses the
  existing rate-limit / WAF configuration in a way that can't be stopped
  with config.

## Disclosure policy

- We follow **coordinated disclosure**: we agree on a public disclosure date
  with the reporter, ship the fix, and publish the advisory simultaneously.
- If you publicly disclose before a fix is available, we will still ship the
  fix, but we can't give advance notice to other users.
- If we can't reach you after the 90-day window, we reserve the right to
  disclose unilaterally.

## Credit

We credit security reporters in the advisory and release notes by default.
If you want to remain anonymous, say so in the initial report.

## Hall of fame

(empty so far — be the first!)

---

## For plugin authors

If you publish a bext plugin:

1. Treat `bext-plugin-api` as a public ABI and watch for its security
   advisories.
2. Your plugin's host crate (`bext-plugin-wasm`, `bext-plugin-quickjs`,
   `bext-plugin-nsjail`) provides isolation, but a bug in your plugin can
   still leak data through host function calls — audit accordingly.
3. Report vulnerabilities in the plugin API surface via the same channels
   above. Vulnerabilities in *your own plugin code* are your responsibility.

## For commercial / enterprise users

If you run bext in production and need a guaranteed response time faster
than 48 hours, reach out via the commercial licensing channel (open an
issue tagged `licensing`) to discuss a support contract.
