# QM local setup

This document describes the Phase 1 local baseline for Issue #5. It does not
deploy to Fly.io, AWS or Slack production.

## Toolchains and directories

The existing application remains a pnpm 9 workspace (`apps/*` and
`packages/*`). QM is intentionally outside that workspace at `deploy/qm/` and
uses its own npm package lifecycle. QM CLI `0.1.4` requires Node `>=24.0.0`;
the current repository root must still use the Node/pnpm versions documented by
the application lockfile. Do not add `deploy/qm` to `pnpm-workspace.yaml`.

The checked-in deployment baseline contains only:

- `package.json` with exact `@yc-software/qm@0.1.4` dependency;
- a local Docker `qm.config.jsonc` with no secret values;
- `.env.example` and `.gitignore`;
- operator-facing README/configuration notes.

The official CLI generates additional deployment skills, manifests, sandbox
assets and an `.env` file during `qm init`. Those generated files are not
claimed as completed here because the execution environment could not reach
the npm registry; no generated secret material was fabricated or committed.

## Reproduce the official scaffold

Choose the target explicitly. The bootstrap refuses to guess a target or
overwrite an existing config:

```bash
pnpm qm:init -- \
  --dir /tmp/ai-quest-a1-qm-init \
  --org ai-quest-a1 \
  --target docker
```

The script runs the official command with a fixed package version:

```bash
npm exec --yes --package=@yc-software/qm@0.1.4 -- \
  qm init /tmp/ai-quest-a1-qm-init \
  --org ai-quest-a1 --target docker
```

Use `--target fly` or `--target aws` only after an operator has selected the
hosting target and supplied the corresponding account/region plan. This PR
does not execute those targets.

After initialization, run from the generated directory:

```bash
npm install
npm exec qm -- check --json
npm exec qm -- doctor
```

`check` is the static validation gate. `doctor` is read-only prerequisite
checking. `plan` renders without mutation. `up` starts a local Docker stack;
it is intentionally not run by this PR. Never paste `.env`, a model key, a
Slack token, OAuth secret or generated signing key into chat or Git.

## Validate the checked-in baseline

Once the package can be installed in `deploy/qm`:

```bash
pnpm qm:validate
```

The validator checks the exact package pin before invoking `qm check --json`.
If npm cannot reach the registry and a local `deploy/qm/node_modules/.bin/qm`
does not exist, the command fails and reports the environment blocker; it does
not substitute a handwritten success result.

The teaching contract smoke test does not need the QM runtime or credentials:

```bash
pnpm qm:smoke
```

It runs the server-only local adapter through the same submit → draft → review
→ publish port that a future QM deployment adapter must implement.

## Secret and runtime hygiene

Keep `.env` mode `600` and verify it is ignored before entering values:

```bash
test "$(stat -c '%a' deploy/qm/.env)" = 600
git check-ignore --quiet deploy/qm/.env
```

The deployment directory's ignore rules cover `node_modules`, generated
state, logs, SQLite/runtime databases and Terraform state. The repository
never stores a runtime DB or production deployment artifact.
