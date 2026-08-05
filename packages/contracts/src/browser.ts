/** Default and /browser entry: runtime schemas and DTOs safe for Vite bundles. */
export { publicApiErrorV1Schema, publicErrorCategorySchema } from "./api-error";
export type { PublicApiErrorV1, PublicErrorCategory } from "./api-error";
export { publicActorRoleSchema, publicActorV1Schema } from "./identity";
export type { PublicActorRole, PublicActorV1 } from "./identity";
export { CONTRACT_CATALOG } from "./catalog";
export type { ContractBoundary, ContractCatalogEntry } from "./catalog";
export {
  studentRagAbstentionReasonV1Schema,
  studentRagAskErrorV1Schema,
  studentRagAskRequestV1Schema,
  studentRagAskResponseV1Schema,
  studentRagCitationV1Schema,
  studentRagConfidenceV1Schema,
  studentRagErrorCodeV1Schema,
  studentRagGroundingV1Schema,
  studentRagScopeV1Schema
} from "./student-rag";
export type {
  StudentRagAbstentionReasonV1,
  StudentRagAskErrorV1,
  StudentRagAskRequestV1,
  StudentRagAskResponseV1,
  StudentRagCitationV1,
  StudentRagConfidenceV1,
  StudentRagErrorCodeV1,
  StudentRagGroundingV1,
  StudentRagScopeV1
} from "./student-rag";
