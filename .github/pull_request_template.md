## Summary

What changed and why. Use a Conventional Commits title, for example `fix(client): retry a job on the next route when IPPS fails`.

## Changes

-

## Verification

- [ ] `pnpm --dir server check`
- [ ] `pnpm --dir server test`
- [ ] `cargo clippy --workspace --all-targets` and `cargo test --workspace` in `client/`
- [ ] Docs updated for changed behavior (and `docs/protocol.md` plus fixtures for protocol changes)

## Follow-ups

- [ ]
