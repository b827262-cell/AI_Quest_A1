# AI-SmartBook-R1-PR4

Standalone project copied from **AI-SmartBook-R1 PR #4**.

This repository preserves the PR #4 SmartBook UI/UX baseline as an independent project, including category library, cover UX, reader layout, and knowledge Q&A features.

## Source

Original repository:

```txt
b827262-cell/AI-SmartBook-R1
```

Source PR:

```txt
PR #4 - feat(stu): add category library, cover UX, reader, and chat history
```

Source branch:

```txt
feat/student-category-cover-reader-chat
```

Source commit SHA:

```txt
5d2070da2c2d41d60c653e40f06ebac081f3af1d
```

## Purpose

This repository is used as an independent PR #4 baseline project.

It is separated from the original AI-SmartBook-R1 repository to avoid mixing the large PR #4 UI/UX redesign with other rebuild or recovery branches.

## Main Features

### Student Frontend

* Category-based book library
* Dynamic category counts
* Book cover display and fallback UX
* Book reader page
* Chapter / contents layout
* Right-side knowledge Q&A chat panel
* Chat history persistence
* Session-based chat restoration
* Cross-book chat session isolation

### Admin Backend / Admin UI

* Book management
* Category metadata support
* Cover URL metadata support
* Admin book create/edit flow support
* Student books API envelope preservation

### Data / Runtime

* SQLite-based local development data
* Local runtime DB files are not committed
* DB files should be copied locally when needed

## Apps

```txt
apps/AI-Stu-R1
```

Student frontend application.

```txt
apps/AI-adm-D1
```

Admin frontend and backend services for SmartBook data, parsing, and management.

## Packages

```txt
packages/schema
```

Shared TypeScript types and Zod schemas.

```txt
packages/db
```

SQLite / Drizzle schema, repositories, and migrations.

```txt
packages/ui
```

Shared UI components.

```txt
packages/book-core
```

PDF parsing, content splitting, chapter building, and book QA services.

```txt
packages/student-runtime
```

Student runtime support.

```txt
packages/ai
```

Admin-side AI provider abstraction.

```txt
packages/sync
```

Student data export / import utilities.

```txt
packages/auth
```

Authentication placeholder.

```txt
packages/quiz-core
```

Quiz core placeholder.

## Local Development

Install dependencies:

```bash
pnpm install
```

Run admin API server:

```bash
pnpm --filter AI-adm-D1 server:dev
```

Run student frontend:

```bash
pnpm --filter AI-Stu-R1 dev -- --host 0.0.0.0 --port 5173
```

Run admin frontend:

```bash
pnpm --filter AI-adm-D1 dev -- --host 0.0.0.0 --port 5174
```

## Recommended Local Ports

Default local development ports:

```txt
Admin API:        http://127.0.0.1:4300
Student frontend: http://127.0.0.1:5173
Admin frontend:   http://127.0.0.1:5174
```

When running this repository together with another SmartBook workspace, use separated ports to avoid conflicts, for example:

```txt
Admin API:        http://127.0.0.1:4310
Student frontend: http://127.0.0.1:5183
Admin frontend:   http://127.0.0.1:5184
```

## Validation

Run student validation:

```bash
pnpm --filter AI-Stu-R1 typecheck
pnpm --filter AI-Stu-R1 build
```

Run admin validation:

```bash
pnpm --filter AI-adm-D1 typecheck
pnpm --filter AI-adm-D1 build
```

When using a shared pnpm store:

```bash
pnpm --config.store-dir=/home/b827262/project/.pnpm-store --filter AI-Stu-R1 typecheck
pnpm --config.store-dir=/home/b827262/project/.pnpm-store --filter AI-Stu-R1 build
pnpm --config.store-dir=/home/b827262/project/.pnpm-store --filter AI-adm-D1 typecheck
pnpm --config.store-dir=/home/b827262/project/.pnpm-store --filter AI-adm-D1 build
```

## SQLite DB Policy

SQLite DB files are local runtime data and must not be committed.

Do not commit files matching:

```txt
*.db
*.sqlite
*.sqlite3
```

Recommended local Git exclude:

```bash
cat >> .git/info/exclude <<'EOF'

# Local SQLite runtime DBs
*.db
*.sqlite
*.sqlite3
EOF
```

Check DB safety:

```bash
git ls-files | grep -E '\.db$|\.sqlite$|\.sqlite3$' || echo "PASS: no SQLite DB tracked by git"
git status --short --untracked-files=all | grep -E '\.db|\.sqlite|\.sqlite3' || echo "PASS: no SQLite DB appears in git status"
```

SQLite integrity check:

```bash
find . \
  -type f \
  \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) \
  -print | while read -r db; do
    echo
    echo "===== $db ====="
    sqlite3 "$db" "PRAGMA integrity_check;"
  done
```

Expected result:

```txt
ok
```

## Repository Relationship

```txt
AI-SmartBook-R1
```

Original repository and historical development source.

```txt
AI-SmartBook-R1-PR4
```

Standalone copy of PR #4. This repository is intended to preserve the large PR #4 UI/UX baseline as an independent project.

```txt
AI-SmartBook-R2
```

Separate clean rebuild / recovery workspace. It should not be confused with this PR #4 standalone project.

## Safety Notes

* This repository was created from PR #4 content.
* PR #4 was not merged into the original main branch.
* This repository should be treated as an independent baseline.
* SQLite DB files are local-only runtime data.
* Do not commit local database files.
* Do not mix unrelated AntiG commits or unrelated project history into this repository.

## Current Baseline

```txt
Source repo:    b827262-cell/AI-SmartBook-R1
Source PR:      #4
Source branch:  feat/student-category-cover-reader-chat
Source SHA:     5d2070da2c2d41d60c653e40f06ebac081f3af1d
New repo:       b827262-cell/AI-SmartBook-R1-PR4
Default branch: main
```

## Option A Deployment Baseline

This repository has converged to **Option A** for 1GB student host production deployment:

* **Static Assets Only**: The 1GB student node serves only static frontend SPA assets.
* **No Database**: No active `student.db` or sqlite-api runs as part of the production path on the 1GB host.
* **No PDF Assets**: No raw PDF books are stored on the 1GB host.
* **Centralized API proxy**: Nginx on the 1GB host proxies all API requests directly to the E500 central API:
  - `/api/student/*` -> Proxied to E500 (`http://e500:4321`)
  - `/api/appearance-settings` -> Proxied to E500 (`http://e500:4321`)
  - `/api/uploads/*` -> Proxied to E500 (`http://e500:4321`)
* **Strict Security Guard**: Nginx explicitly denies or returns `404` for `/uploads/books/*`. Students must authenticate and obtain a valid session ID, then stream PDFs securely via the `pdf-view` API endpoint.

### E500 Runtime Fixes (2026-06-29)
The central database (`book_files`) paths were corrected to eliminate legacy references to other local paths (e.g. `AI-SmartBook-R1` and `AI-SmartBook-R2`). The current status is:
* DB paths are fully updated to point to `/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books/`.
* 100% of recorded PDF documents physically exist and pass filesystem integrity checks.

