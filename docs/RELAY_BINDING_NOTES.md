# Relay Binding 环境契约

> 本文档说明 Relay 验证模块的环境绑定契约，基于 `site/lib/relay-verification.ts` 和 `site/lib/relay-signature.ts` 的实际实现。

## 1. 环境绑定查询顺序

### 1.1 binding() 函数

Relay 模块通过 `binding(name)` 函数查询环境变量，查询顺序如下：

```typescript
type Runtime = Record<string, unknown> & { __env__?: Record<string, unknown> };

function binding(name: string): unknown {
  const runtime = globalThis as unknown as Runtime;
  return runtime[name] ?? runtime.__env__?.[name];
}
```

**查询顺序**：
1. **第一优先级**：`globalThis[name]` — 直接在全局对象上查找
2. **第二优先级**：`globalThis.__env__[name]` — 在 `__env__` 命名空间下查找
3. **未找到**：返回 `undefined`

**设计意图**：
- 支持多种部署环境：Node.js 进程（`process.env` 映射到 `globalThis`）、Edge Runtime（`__env__` 命名空间）
- 保持向后兼容：旧部署可直接在 `globalThis` 上设置环境变量
- 新部署推荐使用 `__env__` 命名空间，避免与全局变量冲突

### 1.2 相关环境变量

| 变量名 | 用途 | 查询方式 |
|--------|------|----------|
| `A01_RELAY_MODE` | Relay 验证模式 | `binding("A01_RELAY_MODE")` |
| `A01_RELAY_KEY_STUDENT` | 学生端 Relay 密钥 | `binding("A01_RELAY_KEY_STUDENT")` |
| `A01_RELAY_KEY_STUDENT_PREV` | 学生端前一个密钥（轮换） | `binding("A01_RELAY_KEY_STUDENT_PREV")` |
| `A01_RELAY_KEY_ADMIN` | 管理端 Relay 密钥 | `binding("A01_RELAY_KEY_ADMIN")` |
| `A01_RELAY_KEY_ADMIN_PREV` | 管理端前一个密钥（轮换） | `binding("A01_RELAY_KEY_ADMIN_PREV")` |

## 2. readRelayMode Fail-Closed 规则

### 2.1 函数实现

```typescript
export function readRelayMode(): RelayMode {
  const value = binding("A01_RELAY_MODE");
  if (value === undefined || value === null) return "off";
  if (typeof value !== "string") return "strict";
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "off") return "off";
  return normalized === "transitional" ? "transitional" : "strict";
}
```

### 2.2 模式解析规则

| A01_RELAY_MODE 值 | 返回模式 | 说明 |
|-------------------|----------|------|
| `undefined` / `null` | `"off"` | 未设置时保持现有部署行为 |
| 非字符串类型（数字、布尔等） | `"strict"` | **Fail-closed**：类型错误时启用严格模式 |
| `""`（空字符串） | `"off"` | 空值视为关闭 |
| `"off"` / `"OFF"` / `" Off "` | `"off"` | 明确关闭（忽略大小写和空白） |
| `"transitional"` / `"Transitional"` | `"transitional"` | 过渡模式（忽略大小写和空白） |
| 其他任何字符串 | `"strict"` | **Fail-closed**：拼写错误时启用严格模式 |

### 2.3 Fail-Closed 设计原则

**核心原则**：不正确的配置值比未配置更危险，因此应触发最严格的行为。

- **未设置**（`undefined`/`null`）：视为有意保持现有部署，返回 `"off"`
- **类型错误**（非字符串）：无法确定意图，返回 `"strict"` 保护系统
- **拼写错误**（如 `"strcit"`、`"transition"`）：无法确定意图，返回 `"strict"` 保护系统

**三种模式行为**：
- `"off"`：跳过 Relay 验证，保持现有部署行为
- `"transitional"`：记录验证失败但不拒绝请求
- `"strict"`：验证失败时拒绝请求

## 3. A01_RELAY_MODE 测试与部署注入规范

### 3.1 测试环境注入

在测试环境中，应通过以下方式注入 `A01_RELAY_MODE`：

```typescript
// 测试前设置
globalThis.A01_RELAY_MODE = "strict";

// 或使用 __env__ 命名空间
globalThis.__env__ = { A01_RELAY_MODE: "strict" };

// 测试后清理
delete globalThis.A01_RELAY_MODE;
delete globalThis.__env__;
```

### 3.2 部署环境注入

#### Node.js 环境

```bash
# 通过 process.env 注入（需映射到 globalThis）
export A01_RELAY_MODE=strict
```

#### Edge Runtime 环境

```json
// 部署配置
{
  "__env__": {
    "A01_RELAY_MODE": "strict"
  }
}
```

### 3.3 密钥注入规范

**密钥要求**：
- 最小长度：32 字符
- 格式：字符串类型
- 密钥对：每个站点（student/admin）支持当前密钥和前一个密钥（用于轮换）

**环境变量设置**：
```bash
# 学生端密钥
export A01_RELAY_KEY_STUDENT="<32字符以上的密钥>"
export A01_RELAY_KEY_STUDENT_PREV="<前一个密钥，用于轮换>"

# 管理端密钥
export A01_RELAY_KEY_ADMIN="<32字符以上的密钥>"
export A01_RELAY_KEY_ADMIN_PREV="<前一个密钥，用于轮换>"
```

## 4. SITE_ROLE 测试与部署注入规范

### 4.1 站点角色识别

Relay 验证通过请求路径识别站点角色：

```typescript
const prefix = `/api/${parsed.site}`;
// parsed.site 为 "student" 或 "admin"
```

**路径策略**：
- `/api/health`：健康检查端点，两个站点均可访问
- `/api/student/*`：学生端 API
- `/api/admin/*`：管理端 API

### 4.2 密钥隔离规则

**关键安全规则**：学生端和管理端必须使用不同的密钥。

```typescript
function siteKeys(site: "student" | "admin"): string[] {
  const own = configuredKeys(site);
  const other = configuredKeys(site === "student" ? "admin" : "student");
  // 如果任何两个站点共享一个密钥，拒绝两个站点直到绑定被修复。
  return own.some((key) => other.includes(key)) ? [] : own;
}
```

**共享密钥检测**：
- 当学生端和管理端共享任一密钥时，`siteKeys()` 返回空数组
- 空数组导致验证失败，返回 `{ status: "invalid" }`
- 此设计防止密钥意外共享导致的安全漏洞

### 4.3 测试注入示例

```typescript
// 测试学生端
globalThis.A01_RELAY_KEY_STUDENT = "test-student-key-32-chars-long-enough";
globalThis.A01_RELAY_KEY_ADMIN = "test-admin-key-32-chars-long-enough-different";

// 测试密钥轮换
globalThis.A01_RELAY_KEY_STUDENT = "new-student-key-32-chars-long-enough";
globalThis.A01_RELAY_KEY_STUDENT_PREV = "old-student-key-32-chars-long-enough";
```

## 5. 验证流程摘要

### 5.1 请求验证流程

1. **检查 Relay 头**：`hasRelayHeaders()` 检测 `x-a01-relay-*` 前缀的头
2. **解析头**：`parseRelayHeaders()` 提取 site、ts、nonce、userId、email、role、signature
3. **时间戳验证**：`checkTimestamp()` 检查时钟偏差（最大 300 秒）
4. **密钥获取**：`siteKeys()` 获取站点对应的密钥列表
5. **签名验证**：`verifyRelay()` 验证请求签名
6. **Nonce 防重放**：非 GET/HEAD 请求插入 nonce 到数据库，防止重放攻击

### 5.2 验证结果类型

```typescript
export type RelayVerification =
  | { status: "none" }           // 无 Relay 头，跳过验证
  | { status: "invalid" }        // 验证失败
  | { status: "valid"; userId: string; email: string };  // 验证成功
```

## 6. 安全注意事项

1. **密钥长度**：密钥必须 ≥ 32 字符，短密钥将被忽略
2. **密钥隔离**：学生端和管理端必须使用不同的密钥
3. **Fail-Closed**：配置错误时启用严格模式，而非关闭验证
4. **Nonce 防重放**：每个 nonce 只能使用一次，过期时间为时间戳 + 300 秒
5. **请求体限制**：
   - 普通请求：8 MiB
   - 上传请求：21 MiB（base64 编码的 15 MiB PDF）
