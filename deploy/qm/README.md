# AI_Quest_A1 QM deployment baseline

This is a standalone QM deployment directory, kept outside the pnpm workspace.
It records the exact `@yc-software/qm@0.1.4` interpreter and a local Docker
target for future operator setup. The directory does not vendor QM core source.

The checked-in config is a non-production baseline. Do not run `qm up` until a
human operator has supplied an approved model provider, local Docker resources,
and the required secret values in the gitignored `.env` file.

Use the repository-level scripts to reproduce or validate the deployment:

```bash
# The target is required; the bootstrap never guesses Fly/AWS/Docker.
pnpm qm:init -- --dir /tmp/ai-quest-a1-qm-init --org ai-quest-a1 --target docker

# Once the exact package has been installed in this directory:
pnpm qm:validate
```

This directory is still incomplete until an actual Node 24 `qm init` comparison
has supplied the generated lockfile, deployment runbook/skill, Slack manifests,
sandbox example, and generated secret catalog. Do not represent this manual
baseline as official init output.

For the official directory contract and lifecycle, see the upstream QM
`cli/README.md` and `docs/deploy-directory.md`. `qm check` is the static gate;
`qm doctor` is read-only prerequisite checking; `qm up` is deliberately not part
of this change.
