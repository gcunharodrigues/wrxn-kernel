# wrxn

The WRXN Kernel — an installable AI operating system. One kernel, two install profiles
(`project` | `workspace`), pull-based updates, and a managed/seeded/state file-class engine
so an update can never overwrite your config or touch your data.

> **Status: walking skeleton** (wrxn-kernel-05). This is the first tracer — the file-class
> install engine plus a minimal payload. The full pipeline, intelligence layer, worktree
> lifecycle, and `wrxn update`/`connect` land in later slices. PRD provenance: the WRXN Kernel
> extraction grill (12 locked decisions, 2026-06-12).

## Usage

```sh
wrxn --version                       # print the kernel version
wrxn init [--project] [--root <dir>] # lay the kernel payload into <dir> (default: cwd)
```

## File classes

Every shipped file is classified in `manifest.json`:

| Class | On install | On update | Example |
|-------|-----------|-----------|---------|
| **managed** | laid | overwritten (kernel-owned) | `.claude/constitution.md`, hooks, skills |
| **seeded** | created once | never overwritten | `.claude/constitution.local.md` |
| **state** | created empty | never touched | `.wrxn/wiki/` |

The installer refuses any payload file the manifest cannot classify.

## Develop

```sh
npm test    # node:test — engine + idempotency + packed-tarball e2e
```

The kernel self-hosts: it is built with its own installed pipeline, and `npm test` green is the
push gate (Constitution Art. III).
