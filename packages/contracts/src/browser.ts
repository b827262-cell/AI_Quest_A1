/** Default and /browser entry: runtime schemas and DTOs safe for Vite bundles. */
export { publicApiErrorV1Schema, publicErrorCategorySchema } from "./api-error";
export type { PublicApiErrorV1, PublicErrorCategory } from "./api-error";
export { publicActorRoleSchema, publicActorV1Schema } from "./identity";
export type { PublicActorRole, PublicActorV1 } from "./identity";
export { CONTRACT_CATALOG } from "./catalog";
export type { ContractBoundary, ContractCatalogEntry } from "./catalog";
