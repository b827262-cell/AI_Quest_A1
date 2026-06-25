# R2 Schema & Repository Foundation Plan

This document outlines the proposed changes for establishing the schema and repository foundation for the **R2 Module Integration Center** (`R2 模組整合中心`).

## 1. Zod Schemas (`packages/schema`)

We will create a new schema file [r2Integration.schema.ts](file:///home/b827262/project/AI-SmartBook-R1-PR4/packages/schema/src/r2Integration.schema.ts) defining Zod schemas that match the data structures defined in the architecture design.

### Proposed Schema Structure

```typescript
import { z } from "zod";

export const r2ModuleStatusValueSchema = z.enum(["green", "yellow", "red", "gray"]);
export type R2ModuleStatusValue = z.infer<typeof r2ModuleStatusValueSchema>;

export const r2TypecheckStatusSchema = z.enum(["pass", "fail", "pending"]);
export type R2TypecheckStatus = z.infer<typeof r2TypecheckStatusSchema>;

export const r2ModuleStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  moduleBranch: z.string(),
  status: r2ModuleStatusValueSchema.default("gray"),
  lastCommit: z.string().optional(),
  lastValidatedAt: z.string().optional(),
  typecheckStatus: r2TypecheckStatusSchema.default("pending"),
  buildStatus: r2TypecheckStatusSchema.default("pending"),
  smokeTestStatus: r2TypecheckStatusSchema.default("pending"),
  blockers: z.array(z.string()).default([]),
  ownedAreas: z.array(z.string()).default([]),
  relatedRoutes: z.array(z.string()).default([]),
  relatedFiles: z.array(z.string()).default([])
});
export type R2ModuleStatus = z.infer<typeof r2ModuleStatusSchema>;

export const r2IntegrationStatusSchema = z.object({
  branch: z.string().default("r2/integration"),
  overallStatus: r2ModuleStatusValueSchema.default("gray"),
  modules: z.array(r2ModuleStatusSchema).default([]),
  currentBlockers: z.array(z.string()).default([]),
  lastReportPath: z.string().optional(),
  updatedAt: z.string().optional()
});
export type R2IntegrationStatus = z.infer<typeof r2IntegrationStatusSchema>;
```

## 2. Database Schema and Repository (`packages/db`)

Instead of introducing a brand new SQLite database table, we can leverage the generic key-value store [appSettings](file:///home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/schema.ts#L115) using a dedicated settings key `'r2_integration_status'`. This has several advantages:
1. **Zero Migration Overhead**: Safe to deploy, avoids writing complex SQLite table changes or Drizzle migrations for nested structures.
2. **Dynamic Serialization**: Fully type-safe because it leverages Zod schemas for runtime validation, parsing, and serialization.

We will create a repository file [r2Integration.repo.ts](file:///home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/r2Integration.repo.ts) containing functions to load, save, initialize, and patch module status entries:

```typescript
import type { Db } from "../client";
import { appSettings } from "../schema";
import { eq } from "drizzle-orm";
import { nowIso } from "./util";
import {
  r2IntegrationStatusSchema,
  type R2IntegrationStatus,
  type R2ModuleStatus
} from "@ai-smartbook/schema";

const R2_INTEGRATION_KEY = "r2_integration_status";

const DEFAULT_MODULES: R2ModuleStatus[] = [
  {
    id: "pdf-reader-ai-core",
    name: "PDF Reader & AI Core",
    moduleBranch: "module/pdf-reader-ai-core",
    status: "gray",
    blockers: [],
    ownedAreas: ["apps/AI-Stu-R1/src/components/Reader"],
    relatedRoutes: ["/pdf-view"],
    relatedFiles: []
  },
  {
    id: "book-content-pipeline",
    name: "Book / Content Pipeline",
    moduleBranch: "module/book-content-pipeline",
    status: "gray",
    blockers: [],
    ownedAreas: ["packages/book-core"],
    relatedRoutes: ["/api/admin/books/:bookId/upload"],
    relatedFiles: []
  },
  {
    id: "admin-files-settings",
    name: "Admin / Files / Settings",
    moduleBranch: "module/admin-files-settings",
    status: "gray",
    blockers: [],
    ownedAreas: ["apps/AI-adm-D1/src/components/FilesTab"],
    relatedRoutes: ["/api/admin/settings"],
    relatedFiles: []
  },
  {
    id: "smart-ai-backend",
    name: "Smart AI Backend",
    moduleBranch: "module/smart-ai-backend",
    status: "gray",
    blockers: [],
    ownedAreas: ["packages/ai"],
    relatedRoutes: [],
    relatedFiles: []
  },
  {
    id: "question-bank-solve",
    name: "Question Bank / Solve",
    moduleBranch: "module/question-bank-solve",
    status: "gray",
    blockers: [],
    ownedAreas: ["packages/quiz-core"],
    relatedRoutes: [],
    relatedFiles: []
  }
];

export function makeR2IntegrationRepo(db: Db) {
  return {
    get(): R2IntegrationStatus {
      const row = db.select().from(appSettings).where(eq(appSettings.key, R2_INTEGRATION_KEY)).get();
      if (!row) {
        // Return default R2 status if not present in DB
        return {
          branch: "r2/integration",
          overallStatus: "gray",
          modules: DEFAULT_MODULES,
          currentBlockers: [],
          updatedAt: nowIso()
        };
      }
      try {
        const parsed = JSON.parse(row.value);
        return r2IntegrationStatusSchema.parse(parsed);
      } catch {
        return {
          branch: "r2/integration",
          overallStatus: "gray",
          modules: DEFAULT_MODULES,
          currentBlockers: [],
          updatedAt: nowIso()
        };
      }
    },

    save(status: R2IntegrationStatus): void {
      const ts = nowIso();
      const validated = r2IntegrationStatusSchema.parse({ ...status, updatedAt: ts });
      const value = JSON.stringify(validated);

      db.insert(appSettings)
        .values({ key: R2_INTEGRATION_KEY, value, updatedAt: ts })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ts } })
        .run();
    },

    updateModule(moduleId: string, patch: Partial<R2ModuleStatus>): R2IntegrationStatus {
      const current = this.get();
      const updatedModules = current.modules.map(mod => {
        if (mod.id === moduleId) {
          return { ...mod, ...patch };
        }
        return mod;
      });

      // Recalculate overall status based on module status hierarchy
      // red > yellow > gray > green
      let overall: R2IntegrationStatus["overallStatus"] = "green";
      const statuses = updatedModules.map(m => m.status);
      if (statuses.includes("red")) {
        overall = "red";
      } else if (statuses.includes("yellow")) {
        overall = "yellow";
      } else if (statuses.includes("gray") && statuses.every(s => s === "gray" || s === "green")) {
        overall = "gray";
      }

      const updatedBlockers = updatedModules.reduce<string[]>((acc, mod) => {
        return acc.concat(mod.blockers);
      }, []);

      const nextStatus: R2IntegrationStatus = {
        ...current,
        overallStatus: overall,
        modules: updatedModules,
        currentBlockers: updatedBlockers
      };

      this.save(nextStatus);
      return nextStatus;
    }
  };
}
```

---

## 3. Integration with the Workspace

To complete this foundation, we will hook this schema and repository into the monorepo exports:
1. Export the new schemas in [packages/schema/src/index.ts](file:///home/b827262/project/AI-SmartBook-R1-PR4/packages/schema/src/index.ts).
2. Export the new repository in [packages/db/src/repositories/index.ts](file:///home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/index.ts).
3. Include the repository instance in the main DB interface in [packages/db/src/index.ts](file:///home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/index.ts).
