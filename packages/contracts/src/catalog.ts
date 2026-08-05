export type ContractBoundary = "browser-safe" | "server-only" | "internal";

export type ContractCatalogEntry = Readonly<{
  id: string;
  version: number;
  boundary: ContractBoundary;
  owner: string;
  purpose: string;
  consumers: readonly string[];
  schema: string;
}>;

/** Machine-readable ownership inventory for every Phase 1 public contract. */
export const CONTRACT_CATALOG: readonly ContractCatalogEntry[] = [
  {
    id: "public-api-error",
    version: 1,
    boundary: "browser-safe",
    owner: "Contracts maintainer",
    purpose: "Stable, sanitized API failure envelope",
    consumers: ["Admin browser", "Student browser", "API servers"],
    schema: "publicApiErrorV1Schema"
  },
  {
    id: "public-actor",
    version: 1,
    boundary: "browser-safe",
    owner: "Contracts maintainer + domain reviewer",
    purpose: "Minimal actor identity crossing an API boundary",
    consumers: ["Browser applications", "API servers"],
    schema: "publicActorV1Schema"
  },
  {
    id: "student-rag-ask-request",
    version: 1,
    boundary: "browser-safe",
    owner: "Contracts maintainer + student reviewer",
    purpose: "Public request body of the scoped student RAG question endpoint",
    consumers: ["Student browser", "Student API server"],
    schema: "studentRagAskRequestV1Schema"
  },
  {
    id: "student-rag-ask-response",
    version: 1,
    boundary: "browser-safe",
    owner: "Contracts maintainer + student reviewer",
    purpose: "Public success and error bodies of the scoped student RAG question endpoint",
    consumers: ["Student browser", "Student API server"],
    schema: "studentRagAskResponseV1Schema"
  },
  {
    id: "audit-event",
    version: 1,
    boundary: "server-only",
    owner: "Platform security reviewer",
    purpose: "Sanitized server audit event passed to persistence adapters",
    consumers: ["Application server", "audit persistence adapter"],
    schema: "auditEventV1Schema"
  }
] as const;
