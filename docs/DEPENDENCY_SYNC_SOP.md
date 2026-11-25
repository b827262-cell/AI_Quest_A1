# 依赖同步与 Symlink 维护 SOP

> 本文档为 AI-Quest-A1 项目的依赖同步与 workspace symlink 维护标准作业程序，基于 R9-T6 总工程师核准的 BLOCKER_GUIDANCE 编写。

## 1. pnpm install --frozen-lockfile 标准流程

### 1.1 核心原则

**唯一允许的指令**：`pnpm install --frozen-lockfile`

- `--frozen-lockfile` 保证不修改 `pnpm-lock.yaml`
- lockfile 代表原设计意图，不得随意更改
- 禁止使用无参数 `pnpm install`（会改写 lockfile）

### 1.2 执行步骤

1. **确认环境**：优先在 Dp1050 本机（原生路径 `/data/project/AI-Quest-A1`）执行，避免 sshfs 产生绝对 symlink
2. **执行安装**：
   ```bash
   cd /home/b827262/mnt/dp1050/project/AI-Quest-A1
   pnpm install --frozen-lockfile
   ```
3. **验证安装**：
   ```bash
   # 确认 lockfile 未变更
   git status --porcelain pnpm-lock.yaml
   # 应无输出，表示 lockfile 未修改
   ```

### 1.3 禁止事项

| 禁止行为 | 原因 |
|----------|------|
| 无参数 `pnpm install` | 会改写 lockfile，产生 tracked 变更 |
| 手动修改 `pnpm-lock.yaml` | lockfile 是依赖关系的单一事实来源 |
| 自动降版 | 版本变更需 PM/Owner 核准 |
| 修改 4 个 `package.json` | 属宣告相依降版，变更面大 |
| git commit/push/merge/reset/stash | 未经 PM 核准禁止操作 git |
| 输出 secret/token 真值 | 资安规范 |

### 1.4 Registry 窗口限制

- **时间窗口**：自开始计 **30 分钟**
- **超时处理**：立即停止，回报原始错误
- **重试限制**：最多重试 1 次
- **禁止自动降版**：registry 不可取得时，不得自动改走降版路径

### 1.5 错误处理流程

```
安装失败
  ├─ Registry 超时 → 停止，回报原始错误
  ├─ Lockfile 与 package.json 不同步 → 停止，回报 PM
  └─ 其他错误 → 停止，回报原始错误，不自动处理
```

## 2. sshfs 挂载下绝对 /data symlink 风险

### 2.1 问题成因

**现象**：`packages/auth/node_modules/zod` 指向绝对路径 `/data/project/AI-Quest-A1/packages/schema/node_modules/zod`

**根本原因**：
- pnpm 在 sshfs 挂载的文件系统上创建 symlink 时，可能生成绝对路径而非相对路径
- 绝对路径 `/data/...` 在 sshfs 挂载点（`/home/b827262/mnt/dp1050/`）下无法解析
- 导致 symlink 损坏（broken）且模块无法加载

### 2.2 风险影响

| 影响 | 说明 |
|------|------|
| 模块解析失败 | `require('zod')` 在根层抛出 MODULE_NOT_FOUND |
| 类型检查失败 | `pnpm --filter @ai-smartbook/auth typecheck` 可能失败 |
| 测试失败 | 依赖 zod 的测试无法执行 |
| 构建失败 | 打包时无法解析依赖 |

### 2.3 检测方法

```bash
# 使用专用脚本检测
bash scripts/check-workspace-symlinks.sh --warn-only

# 输出示例：
# links scanned: 94
# broken: 1
# abs-/data/: 1
```

**关键指标**：
- `broken`：目标不存在的 symlink 数量（期望 0）
- `abs-/data/`：指向 `/data/` 绝对路径的 symlink 数量（期望 0）

### 2.4 修复方法

#### 方法 A：重新安装（首选）

```bash
# 在 Dp1050 本机执行（非 sshfs）
pnpm install --frozen-lockfile
```

大多数情况下会重建正确的相对链接。

#### 方法 B：手动修复单个 symlink

```bash
# 确认损坏的 symlink
readlink packages/auth/node_modules/zod
# 输出：/data/project/AI-Quest-A1/packages/schema/node_modules/zod

# 移除损坏的链接
rm packages/auth/node_modules/zod

# 创建相对链接（指向 schema 包的 zod）
ln -s ../../schema/node_modules/zod packages/auth/node_modules/zod
```

**注意**：
- 仅修复已确认损坏的 symlink
- 不得手动修改其他 `node_modules` 链接
- 修复后重新运行检测脚本确认

### 2.5 预防措施

1. **优先在本机执行**：避免通过 sshfs 执行 `pnpm install`
2. **安装后立即检测**：每次安装后运行 `check-workspace-symlinks.sh`
3. **考虑 node-linker=hoisted**：若反复出现，可评估改用 hoisted linker（需 PM 核准）

## 3. R9-T6 §2.4 八项验收清单

> 全数通过才可回报 DONE

| # | 检查项目 | 执行命令 | 期望结果 |
|---|----------|----------|----------|
| 1 | 根层 vitest 解析 | `node -e "require.resolve('vitest')"` | 可解析、exit 0 |
| 2 | auth 包 zod 解析 | `cd packages/auth && node -e "require('zod')"` | 可解析、exit 0 |
| 3 | auth 包类型检查 | `pnpm --filter @ai-smartbook/auth typecheck` | exit 0 |
| 4 | 站点认证测试 | `pnpm run test:site-auth` | 8/8 passed、exit 0 |
| 5 | 发布脚本类型检查 | `pnpm run typecheck:release-scripts` | exit 0 |
| 6 | Symlink 健康检查（strict） | `bash scripts/check-workspace-symlinks.sh` | broken 0、abs-/data/ 0、exit 0 |
| 7 | 边界检查 | `bash scripts/boundary-check.sh` | exit 0、GATE_STATUS: PASS |
| 8 | Git 状态检查 | `git status --porcelain` | 仅既有授权文件；pnpm-lock.yaml 不变 |

> **R12 基準變更軌跡**：原 #1 為「根層 zod 解析」，但根 `package.json` 無 `dependencies`，zod 從未在根層宣告，此為無效基準（t6 R11-T6 §5 提出之疑點）。R13 依 PM 核准改為「根層 vitest 解析」，對齊根 `package.json` 實際 `devDependencies`。

### 3.1 验收执行顺序

```
1. 先执行 #6（symlink 检查）→ 若有问题先修复
2. 再执行 #1-#2（模块解析）→ 确认依赖可加载
3. 执行 #3-#5（类型检查与测试）→ 确认功能正常
4. 执行 #7（边界检查）→ 确认无边界违规
5. 最后 #8（git 状态）→ 确认无意外变更
```

### 3.2 回报格式

```
INSTALL_CMD=pnpm install --frozen-lockfile
INSTALL_EXIT=<0|n>
VERSIONS=zod=<x>,vitest=<x>,vite=<x>,happy-dom=<x>
SYMLINK=<fixed|still-broken>
ACCEPTANCE=<1-8 逐项 exit code>
GIT_STATUS=<pnpm-lock.yaml unchanged: yes/no>
BLOCKER=<无或说明>
```

## 4. 版本漂移监测

### 4.1 当前版本状态

| 套件 | lockfile 宣告 | package.json 宣告 | 实际安装 | 状态 |
|------|--------------|------------------|----------|------|
| zod | 4.6.6 | 4.6.6（4 个 importer） | 4.4.3 | ⚠️ 漂移 |
| vitest | 4.1.12 | ^4.1.12（根）/ 4.1.12（contracts） | 4.1.10 | ⚠️ 漂移 |

**漂移原因**：过期的 `node_modules` 安装，lockfile 与 package.json 一致，但实际安装的版本落后。

### 4.2 版本宣告位置

**zod 宣告**（4 个 package.json）：
- `packages/auth/package.json`: `"zod": "4.6.6"`
- `packages/contracts/package.json`: `"zod": "4.6.6"`
- `packages/schema/package.json`: `"zod": "4.6.6"`
- `apps/AI-adm-D1/package.json`: `"zod": "4.6.6"`

**vitest 宣告**（2 处）：
- `package.json`（根）: `"vitest": "^4.1.12"`
- `packages/contracts/package.json`: `"vitest": "4.1.12"`

**lockfile 宣告**：
- `pnpm-lock.yaml`: `zod@4.6.6`
- `pnpm-lock.yaml`: `vitest@4.1.12(...)`

### 4.3 版本监测方法

```bash
# 检查 lockfile 中的版本
grep 'zod@' pnpm-lock.yaml
grep 'vitest@' pnpm-lock.yaml

# 检查实际安装的版本
ls -d node_modules/.pnpm/zod@*
ls -d node_modules/.pnpm/vitest@*

# 检查 package.json 宣告
grep -rE '"zod"|"vitest"' packages/*/package.json apps/*/package.json
```

### 4.4 版本漂移风险

| 套件 | 风险 | 缓解措施 |
|------|------|----------|
| zod 4.4.3 → 4.6.6 | 同 major 内跨数字版本，schema 验证/类型推论可能有行为差异 | 以 auth typecheck + site-auth 测试把关 |
| vitest 4.1.10 → 4.1.12 | 可能连带 vite 8.2.4/happy-dom 21.x | 以 site-auth 测试 + 全量测试确认 |

### 4.5 版本对齐策略

**首选方案**：依 lockfile 升级（R9-T6 核准）
- 执行 `pnpm install --frozen-lockfile` 使实际安装与 lockfile 对齐
- 不修改 lockfile，不产生 tracked 变更
- 安装后执行八项验收清单确认

**备选方案**：降版对齐实装（需 PM/Owner 核准）
- 需修改 4 个 package.json + 重产 lockfile
- 属宣告相依降版，变更面大
- 仅在 registry 不可取得时，提报 PM 裁示

## 4.6 Lockfile Store Sync 守門檢查（R20）

`pnpm run check:lock-sync` 透過 `scripts/check-lockfile-store-sync.mjs` 唯讀比對 `pnpm-lock.yaml` 中 13 個 workspace importer 的 `dependencies`／`devDependencies`、`node_modules/.pnpm` store 目錄及各 workspace `node_modules/<package>/package.json` 實際版本。`link:` 與 `workspace:` 本地連結會略過；peer suffix 不影響裸版本比對。

**Release Gate 使用 strict 模式**：

```bash
corepack pnpm@9.15.0 run check:lock-sync
```

無漂移時輸出 `RESULT: OK` 並 exit 0；任何 store 目錄缺失、workspace 套件缺失或實際版本與 lockfile 不符時，列出 `DRIFT` 明細並 exit 1。此檢查不會安裝或修改依賴，也不會修改 lockfile。

**診斷時可使用 warn-only**：

```bash
node scripts/check-lockfile-store-sync.mjs --warn-only
```

warn-only 一樣輸出每項漂移與統計，但結果為 `RESULT: WARN` 並 exit 0，供盤點或診斷使用；它不代表通過 strict Release Gate，正式驗收仍須執行上方不帶參數的命令。根 `package.json` 第 26 行定義 `"check:lock-sync": "node scripts/check-lockfile-store-sync.mjs"`。

## 5. 附录：相关脚本与文件

### 5.1 检测脚本

| 脚本 | 用途 |
|------|------|
| `scripts/check-workspace-symlinks.sh` | Symlink 健康检查（`--warn-only` 模式 exit 0） |
| `scripts/boundary-check.sh` | 边界检查（GATE_STATUS: PASS/FAIL） |

### 5.2 相关文档

| 文件 | 内容 |
|------|------|
| `reports/dispatch/R9-T6.md` | 总工程师技术核准与 BLOCKER_GUIDANCE |
| `docs/RELAY_BINDING_NOTES.md` | Relay 验证环境契约 |

### 5.3 关键路径

| 路径 | 说明 |
|------|------|
| `/home/b827262/mnt/dp1050/project/AI-Quest-A1` | Dp1050 sshfs 挂载点 |
| `/data/project/AI-Quest-A1` | Dp1050 本机原生路径 |
| `node_modules/.pnpm/` | pnpm 存储目录 |
| `packages/*/node_modules/` | workspace 包的 node_modules |

## 6. pnpm 11 × packageManager pnpm@9.15.0 防呆

### 6.1 根因描述

**问题**：系统全局 pnpm 版本为 11.x，而本项目 `package.json` 宣告 `packageManager: pnpm@9.15.0`，`pnpm-lock.yaml` 使用 `lockfileVersion: "9.0"` 并内含 5 笔 `pnpm.overrides`。

**根因**：pnpm 11 不再读取 `package.json` 中的 `pnpm.overrides` 配置，改为读取 `pnpm-workspace.yaml`。当以 pnpm 11 执行 `pnpm install --frozen-lockfile` 时，会因配置不匹配而触发：

```
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
Cannot proceed with the frozen installation.
The current 'overrides' configuration doesn't match the value found in the lockfile.
```

`--frozen-lockfile` 会直接中止安装流程。

**注意**：「Lockfile is not up to date」属于另一个错误码 `ERR_PNPM_OUTDATED_LOCKFILE`，与 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 不同，勿混淆。

### 6.2 副作用警示

**危险**：在 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 中止前，pnpm 11 可能已执行「Recreating node_modules」步骤，导致：

1. **旧 node_modules 被清空**：顶层 `node_modules/` 与 `.pnpm/` 目录内容归零
2. **workspace symlink 损坏**：所有 workspace 包的 symlink 变为 broken
3. **R10 实测数据**：73 条 broken symlink 出现，模块完全无法加载

**影响**：
- 所有 `require()` 调用失败
- 类型检查无法执行
- 测试套件无法运行
- 构建流程中断

### 6.3 唯一正确操作

**强制使用 pnpm@9.15.0**：一律通过 corepack 或 npx 指定版本执行：

```bash
# 方法一：corepack（推荐）
corepack pnpm@9.15.0 -v
# 应输出：9.15.0

corepack pnpm@9.15.0 install --frozen-lockfile
```

```bash
# 方法二：npx（备选）
npx -y pnpm@9.15.0 install --frozen-lockfile
```

**执行前确认**：
```bash
# 确认 pnpm@9.15.0 可用
corepack pnpm@9.15.0 -v
# 应输出：9.15.0
```

### 6.4 禁令清单

| 禁止行为 | 原因 |
|----------|------|
| 以系统 pnpm 11 执行安装 | 会触发 LOCKFILE_CONFIG_MISMATCH |
| **未经 PM/Owner 具体授权**使用 `CI=true` 无 TTY 绕道确认 | 会直接重建 modules，清空 node_modules |
| 重复重试 | 零重试政策，避免反复清空 |
| 修改 pnpm-lock.yaml | lockfile 是依赖关系的单一事实来源 |
| 降版 package.json 中的 pnpm 宣告 | 属宣告相依变更，需 PM 核准 |
| 更换 registry | 可能引入不一致的依赖版本 |

**授权例外**：`CI=true` 默认禁止。仅当 PM/Owner 对重建风险（清空 node_modules、73 条 broken symlink）作出具体书面授权时，方可按授权执行 `CI=true corepack pnpm@9.15.0 install --frozen-lockfile`。授权执行须同时满足：

1. **记录重建风险**：执行前在回报中明确记录已认知重建风险
2. **R11 专属**：本授权仅适用于 R11 轮次，不得暗示其他轮次自动获准
3. **30 分钟窗口**：自开始执行计 30 分钟，超时即停
4. **零重试**：执行失败不重试，立即回报 t2（PM 秘书）与 t6（总工程师）

### 6.5 恢复步骤

若已因 pnpm 11 导致 node_modules 破損，依以下流程恢复：

```
1. 确认 lockfile 完整性
   sha256sum pnpm-lock.yaml
   # 与基准值比对，确保 lockfile 未被修改

2. 以 pnpm@9.15.0 执行冻结安装
   NODE_ENV=development CI=true corepack pnpm@9.15.0 install --frozen-lockfile
   # NODE_ENV=development：确保安装 devDependencies（vitest/typescript）
   # CI=true：防止非 TTY 环境重现 NO_TTY 卡停

3. 执行 R9-T6 §2.4 八项验收清单
   - #1 根层 vitest 解析（R13 基准修订，原 zod 项为无效基准）
   - #2 auth 包 zod 解析
   - #3 auth 包类型检查
   - #4 站点认证测试
   - #5 发布脚本类型检查
   - #6 Symlink 健康检查（strict）
   - #7 边界检查
   - #8 Git 状态检查

4. Symlink 严格检查
   bash scripts/check-workspace-symlinks.sh
   # 期望：broken 0、abs-/data/ 0、exit 0

5. 回报 t2/t6
   全数通过才可回报 DONE
```

### 6.6 30 分钟窗口

- **时间窗口**：自开始恢复流程计 **30 分钟**
- **超时处理**：立即停止，回报 t2（PM 秘书）与 t6（总工程师）
- **重试限制**：零重试，超时即停
- **禁止自动处理**：不得在超时后自动降版或更换 registry

### 6.7 NODE_ENV=production 事前检查与事故后排查

**现象**：当 `NODE_ENV=production` 环境变量被设置时，pnpm 会跳过 `devDependencies` 的安装，导致：

1. **测试框架缺失**：`vitest`、`happy-dom` 等开发依赖未安装
2. **类型检查失败**：`typescript` 未安装，无法执行类型检查
3. **构建工具缺失**：`vite` 等构建工具未安装

**R11 实测证据**：
- `node_modules/.pnpm` 仅 108 笔 production 依赖（有 express/better-sqlite3）
- 缺少 typescript/vitest/vite/happy-dom 等 devDependencies
- `pnpm run test:site-auth` → exit 1、`sh: 1: vitest: not found`
- `bash scripts/boundary-check.sh` → exit 1、`Cannot find module 'typescript/unstable/ast'`

**事前检查**：执行安装前，确认 `NODE_ENV` 未设置为 `production`：

```bash
# 检查 NODE_ENV
env | grep NODE_ENV
# 若有输出 NODE_ENV=production，请先 unset
unset NODE_ENV

# 再执行安装
NODE_ENV=development CI=true corepack pnpm@9.15.0 install --frozen-lockfile
# NODE_ENV=development：确保安装 devDependencies（vitest/typescript）
# CI=true：防止非 TTY 环境重现 NO_TTY 卡停
```

**事故后排查**：若发现测试框架或类型检查工具缺失，但 production 依赖存在，应排查：

```bash
# 1. 检查 NODE_ENV 是否被设置
env | grep NODE_ENV

# 2. 检查 node_modules/.pnpm 目录内容
ls node_modules/.pnpm | wc -l
# 若仅 108 笔左右，且缺少 vitest/typescript，可能是 production 模式安装

# 3. 检查 shell 启始档是否有 NODE_ENV 设定
grep -r "NODE_ENV" ~/.bashrc ~/.bash_profile ~/.profile 2>/dev/null

# 4. 若无 NODE_ENV=production，但仍缺少 devDependencies
# 可能是其他原因导致，需进一步排查
```
