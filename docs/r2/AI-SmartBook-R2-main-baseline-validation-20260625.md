# AI-SmartBook-R2 Main Baseline Validation

Date: 2026-06-25  
Branch: `main`
Scope: `Student` baseline recovery for `AI-Stu-R1`

## Pre-check

- `pnpm-lock.yaml` 先以 `git show HEAD:pnpm-lock.yaml` 還原，避免非目標改動（`puppeteer` 相關 lock 區段差異）混入本輪。
- `corepack enable` 在目前環境會遇到 `/usr/bin/yarn` 權限拒絕（`EACCES: permission denied, symlink`），目前不影響 `pnpm install`，先記錄為 warning，不將其視為 blocker。

## Typecheck / Build 驗證

以下皆以 `PNPM_HOME=/tmp/pnpm-corepack Pnpm_config_store_dir=/tmp/pnpm-store` 執行：

- `pnpm --filter AI-Stu-R1 typecheck`
- `pnpm --filter AI-Stu-R1 build`
- `pnpm --filter AI-adm-D1 typecheck`
- `pnpm --filter AI-adm-D1 build`

## Result

- `AI-Stu-R1`: typecheck ✅ / build ✅
- `AI-adm-D1`: typecheck ✅ / build ✅

## Next

- 目前不進入 `feat/r2-schema-repository-foundation-20260625`。
- baseline 綠燈後再進入下一階段模組整合。
