# Contributing

Thanks for helping.

## Setup

You need:

- Node.js 22.12 or later with pnpm, for the server
- Rust 1.92 or later, for the client

All installs stay inside the repo.

```sh
scripts/dev.sh   # installs packages, migrates the local D1, and serves http://localhost:5173
```

The first run copies `server/.dev.vars.example` to `server/.dev.vars`. Git ignores that file.

To run a client against the local server, create a pairing code under **Devices > Add a device**, then:

```sh
cd client
cargo run -p printbetter -- pair --server http://localhost:5173 --token pbe_…
cargo run -p printbetter -- run   # status page at http://127.0.0.1:47631
```

[docs/architecture.md](docs/architecture.md) explains the layout.

Code rules:

- Minimal dependencies
- Files under 300 lines
- Short comments that explain why

## Before You Open a Pull Request

```sh
pnpm --dir server check
pnpm --dir server test
pnpm --dir server build
cd client && cargo clippy --workspace --all-targets && cargo test --workspace
```

All of them must pass.

When you change behavior, update the doc in `docs/` that describes it. When you change the messages between the server and the client, update [docs/protocol.md](docs/protocol.md) and the fixtures in `client/crates/app/tests/fixtures/protocol/`.

The tests use local fakes. They don't need a Cloudflare account or a real printer.

## Branches

`main` is the default branch and holds releases. Create feature branches from `main` and open pull requests against `main`.

## Commit and PR Format

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for commit subjects and PR titles:

```text
fix(client): retry a job on the next route when IPPS fails
feat(server): add a per-printer page limit
feat(protocol)!: rename the remote_printers message
```

Keep subjects within 72 characters, in the imperative, without a trailing period.

PR bodies describe:

- The changed behavior
- How you checked it
- Migration steps, for breaking changes

## Versions

Versions follow [Semantic Versioning](https://semver.org/). Tags are `vX.Y.Z`. The server and the client share a single version, set in 3 places:

- `client/Cargo.toml` (`[workspace.package] version`)
- `server/package.json`
- `server/worker/version.ts`

| Commit | Release |
| --- | --- |
| `fix`, `perf`, `revert` | Patch: `0.1.0` → `0.1.1` |
| `feat` | Minor: `0.1.0` → `0.2.0` |
| Any type with `!` or a `BREAKING CHANGE:` footer | Major: `0.1.0` → `1.0.0` |
| `docs`, `chore`, `ci`, `build`, `refactor`, `style`, `test` | No release without a breaking marker |

The compatibility surface includes:

- The REST API
- The MCP tools and their fields
- The client protocol
- The install scripts and `latest.json`
- The `printbetter` CLI
- `wrangler.jsonc` bindings
- The database schema

Protocol changes stay additive: Older clients ignore messages they don't know.

## Releases

The maintainer releases from a clean checkout of `main`:

1. Set the new version in the 3 files above and add a section to [CHANGELOG.md](CHANGELOG.md).
2. Deploy the server: `scripts/deploy.sh`.
3. Build, sign, notarize, and publish the clients: `scripts/release.sh --publish remote`.
4. Tag `vX.Y.Z` and publish the GitHub release with the files from `build/<version>/dist/`.

See [docs/release.md](docs/release.md) for signing, notarization, and platform options.

The GitHub Actions workflows run only when started by hand from the Actions tab.
