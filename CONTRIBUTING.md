# Contributing to bext

Thanks for your interest in bext. Before you invest time in a contribution,
read this whole file — bext has an unusual source layout that changes how
contributions flow.

## How this repo works

**Heads up:** `github.com/bext-stack/bext` is the **public home** for bext,
but it is **not the source of truth**. bext is developed in a private
monorepo. This repo contains:

- The public README and docs
- Release notes and changelogs
- The issue tracker
- Examples and starter projects
- Pointers to the mirror repos (`bext-stack/bext-plugin-api`, `bext-stack/bext-nginx-compat`)

The actual Rust and TypeScript source lives in the private monorepo. Every
tagged release pushes updated subtree splits here automatically — so if you
want to read the code, clone the mirror for the crate you care about, or
browse the published crates on [crates.io](https://crates.io/search?q=bext-).

This layout exists because bext includes commercial code (`bext-license`,
`bext-keygen`, and activ-2 deployment config) that can't live in a public
repo. The BSL 1.1 and MIT crates you see on crates.io are the publishable
subset. See [LICENSE](LICENSE) for the split.

## How to contribute

### Reporting bugs

1. Check the [issue tracker](https://github.com/bext-stack/bext/issues)
   for duplicates.
2. Open an issue using the **Bug** template. Include:
   - bext version (`bext-server version` or crate version from Cargo.toml)
   - Minimal reproducer
   - Expected vs actual behaviour
   - OS / architecture / Rust version
3. If you can't share a reproducer publicly (e.g., it contains a config
   file with secrets), say so — we'll coordinate a private channel.

### Requesting features

Open an issue using the **Feature Request** template. The more specific
you are about the use case, the better the discussion. We prefer
"I'm trying to do X and Y doesn't work" over "please add feature Y".

### Submitting code changes

Because the repo is a mirror, you can't open a PR that directly modifies
bext's source. Instead:

**Small fixes (< 50 lines, no architectural impact)**:

1. Open an issue describing the fix.
2. Attach a patch file (`git diff > fix.patch`), a link to a gist, or a
   reference to a personal fork of one of the mirror repos.
3. A maintainer will replay the patch into the private monorepo, attribute
   you in the commit message, and ship it in the next release.

**Large changes (new features, refactors, architectural changes)**:

1. **Open an issue FIRST** to discuss the design. Don't spend a week
   writing something we're going to say no to.
2. Once the design is agreed, we'll work out a path. Options:
   - Send a patch as above, larger version.
   - Get temporary access to the private monorepo (rare, for trusted
     contributors who sign the [CLA](#contributor-license-agreement)).
   - We implement it based on your spec and credit you.

**Plugin authors**:

If you're writing a plugin against `bext-plugin-api`, your plugin lives in
*your own* repo — no need to contribute it to bext. If you hit a limitation
in the plugin ABI itself, file an issue on this repo. We're aggressive about
adding ABI surface that unblocks real plugins.

**Mirror-repo PRs**:

The mirror repos (`bext-stack/bext-plugin-api`, `bext-stack/bext-nginx-compat`)
are force-pushed from subtree splits on every release. You **can** open a PR
against them, but:

- It won't merge into the mirror (subtree split overwrites it).
- A maintainer will read it, replay the change into the private monorepo,
  and credit you. Same mechanism as a patch-attached issue.

## Contributor License Agreement

Any code contribution to bext must be relicensable by the maintainer. For
small patches (single-commit-sized) a statement in the issue that you agree
to MIT / BSL-1.1 relicensing is sufficient.

For larger contributions, you'll be asked to sign a standard CLA before the
code is integrated. We use a minimal CLA modeled on Apache's — it assigns
copyright to Benjamin Favre (the bext copyright holder) while retaining
your right to use your own code.

If you can't sign a CLA for legal reasons (e.g., employer policy), reach
out first — there may be a structural fix.

## Coding standards

Once your contribution is accepted into the private monorepo, it must match
bext's internal standards. These are not strict but they're consistent:

- **Rust edition 2024** where possible, 2021 where required by upstream deps.
- **No panics** in `bext-core` or `bext-plugin-api`. Return `Result` instead.
  Panics are allowed in `bext-server` for fatal startup errors and in tests.
- **Clippy clean** on `--workspace --all-targets`.
- **Tests required** for new features. Bug fixes should include a regression test.
- **No new third-party dependencies without discussion.** bext aims for a
  lean dependency tree — we've said no to a dozen deps already. Check existing
  crates first.
- **Comments** should explain *why*, not *what*. `// iterate over users`
  adds nothing; `// skip over deleted users because the iterator yields them`
  adds something.

## Style and commit messages

- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:`).
- Present tense, imperative mood: "add X", not "added X" or "adds X".
- Body lines wrap at 72 characters.
- Reference the issue number in the body: `Closes #123`.

## Not accepted

We will politely decline PRs/issues for:

- **Adding new framework adapters** that duplicate existing ones. We have
  adapters for Next.js, Hono, Express, Laravel, Symfony — that's the set.
  File an issue to discuss a new one before writing code.
- **Dependency version bumps without reason**. `cargo update` noise is not
  a contribution.
- **Formatting-only changes**. `rustfmt` runs in CI; manually reformatting
  thousands of lines is pure churn.
- **Renaming things for consistency** unless the rename actually fixes a
  bug or a confusing name. Names carry history; we don't reshuffle lightly.

## Questions?

Open a discussion on the [issue tracker](https://github.com/bext-stack/bext/issues).
Tag it `question`. Or, for commercial inquiries, tag it `licensing`.

Thank you for helping make bext better.
