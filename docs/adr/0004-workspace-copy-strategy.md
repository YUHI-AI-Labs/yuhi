# ADR-0004: Workspace generation by filtered copy

Date: 2026-07-24 · Status: Accepted

## Context
We must give the agent a working tree that excludes blocked/local-only files and
redacts secrets, without modifying the original repo, and safely.

## Decision
Generate a **filtered copy** under `~/.yuhi/workspaces/<id>` (not symlinks, not
in-place mutation, not overlay mounts) for the MVP.

- Enumerate decisions from the policy engine; copy only `allow`/`redact` files.
- `redact` files are transformed in the copy only (mask detected spans).
- Never follow symlinks: `lstat` each entry; skip links, record them in the manifest.
- Confine every write: resolve the destination and assert it stays under the workspace
  root (defense against traversal).
- Write `manifest.json`: yuhi version, policy hash, per-file {relpath, action, rule,
  sourceSha256, outputSha256|null}, symlink/skip list, counts.
- Restrictive dir perms (`0700`) on the workspace root where the OS supports it.

## Alternatives considered
- **Symlink farm**: fast, but exposes originals and defeats redaction. Rejected.
- **Overlay/union mount**: powerful but OS-specific and heavy for MVP. Deferred to a
  future `RunBackend`.
- **In-place with `.yuhiignore`**: would risk modifying the source and relies on agent
  cooperation. Rejected.

## Consequences
Copy cost for large repos (mitigated by ignores + optional cache, `--dry-run`).
Clear separation between original and workspace. Redaction is possible because we own
the copy.
