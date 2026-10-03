import { createHash } from "node:crypto";
import { EXAM_COURSE_RECORD_COLUMNS, examCourseKey, type ExamCourseRecord } from "./exam-course.repo";

/**
 * B2 step 1: validate a B1 public snapshot before anything is written to the
 * database of record.
 *
 * The rules are the ones the owner pinned for B2 (row count, exam years,
 * category, source host, SHA-256 content hash) plus the two invariants the
 * upsert contract silently depends on: no duplicate (exam_year, course_code)
 * key, and a content_hash that actually reproduces from the row it claims to
 * fingerprint.
 */

export const EXAM_COURSE_ALLOWED_YEARS: readonly number[] = [115, 116];
export const EXAM_COURSE_ALLOWED_CATEGORIES: readonly string[] = ["高普考"];
export const EXAM_COURSE_ALLOWED_SOURCE_HOSTS: readonly string[] = ["ec.ibrain.com.tw"];
export const EXAM_COURSE_SNAPSHOT_EXPECTED_ROWS = 16;
export const EXAM_COURSE_SNAPSHOT_SCHEMA_VERSION = "b1-public-exam-course-snapshot/v1";
export const EXAM_COURSE_CONTENT_HASH_ALGORITHM = "sha256";

const HASH_FIELD_SEPARATOR = "\u0001";
const COURSE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,127}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type ExamSnapshotSeverity = "error" | "warning";

export interface ExamSnapshotFinding {
  code: string;
  severity: ExamSnapshotSeverity;
  message: string;
  row_index?: number;
}

export interface ExamSnapshotValidationReport {
  ok: boolean;
  errors: number;
  warnings: number;
  rows: number;
  expected_rows: number;
  exam_years: number[];
  categories: string[];
  source_hosts: string[];
  unique_keys: number;
  duplicate_keys: string[];
  content_hash: {
    algorithm: string;
    format_valid: number;
    reproducible: number;
    matched_variant: string | null;
  };
  manifest: {
    schema_version: string | null;
    declared_rows: number | null;
    record_contract: string[] | null;
    source_host: string | null;
    allowed_exam_years: number[] | null;
  };
  freshness: {
    status: "VERIFIED" | "UNVERIFIED";
    reason: string;
    manifest_claim: string | null;
    evidence: string[];
    conflicts: string[];
  };
  findings: ExamSnapshotFinding[];
}

export interface ValidateExamSnapshotInput {
  rows: readonly unknown[];
  manifest: unknown;
  expectedRows?: number;
  /**
   * Independent proof that the rows were fetched live (a re-fetch record from
   * outside the manifest). The manifest's own `direct_fetch_status` string is a
   * self-assertion and is never treated as proof on its own.
   */
  liveFetchEvidence?: string;
  /** Owner-issued freshness verdict; when present it wins over the heuristic. */
  freshnessOverride?: "VERIFIED" | "UNVERIFIED";
  freshnessOverrideReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const CONTENT_NORMALIZERS: ReadonlyArray<{ name: string; normalize: (value: string) => string }> = [
  { name: "content-as-is", normalize: (value) => value },
  { name: "content-collapsed-whitespace", normalize: (value) => value.replace(/\s+/g, " ").trim() },
  { name: "content-trimmed", normalize: (value) => value.trim() },
  { name: "content-compacted", normalize: (value) => value.replace(/\s+/g, "") },
  { name: "all-fields-lowercased", normalize: (value) => value.toLowerCase() }
];

/**
 * Recomputes the hash recipe the crawl manifest declares: sha256 over
 * exam_year, category, course_code, course_name, normalized course_content and
 * source_url joined by U+0001, with fetched_at deliberately excluded.
 *
 * Every plausible reading of "normalized" is offered because the manifest does
 * not pin the normalization function; the validator reports which variant
 * reproduces the stored hash instead of guessing one silently.
 */
export function examCourseContentHashCandidates(record: ExamCourseRecord): Array<{
  variant: string;
  digest: string;
}> {
  return CONTENT_NORMALIZERS.map(({ name, normalize }) => {
    const fields = [
      String(record.exam_year),
      name === "all-fields-lowercased" ? record.category.toLowerCase() : record.category,
      name === "all-fields-lowercased" ? record.course_code.toLowerCase() : record.course_code,
      name === "all-fields-lowercased" ? record.course_name.toLowerCase() : record.course_name,
      normalize(record.course_content),
      name === "all-fields-lowercased" ? record.source_url.toLowerCase() : record.source_url
    ];
    return {
      variant: name,
      digest: createHash(EXAM_COURSE_CONTENT_HASH_ALGORITHM)
        .update(fields.join(HASH_FIELD_SEPARATOR), "utf8")
        .digest("hex")
    };
  });
}

export function matchExamCourseContentHash(
  record: ExamCourseRecord
): { variant: string; digest: string } | null {
  return (
    examCourseContentHashCandidates(record).find((candidate) => candidate.digest === record.content_hash) ??
    null
  );
}

function collectManifest(manifest: unknown): ExamSnapshotValidationReport["manifest"] {
  if (!isRecord(manifest)) {
    return {
      schema_version: null,
      declared_rows: null,
      record_contract: null,
      source_host: null,
      allowed_exam_years: null
    };
  }
  return {
    schema_version: typeof manifest.schema_version === "string" ? manifest.schema_version : null,
    declared_rows: typeof manifest.rows === "number" ? manifest.rows : null,
    record_contract: Array.isArray(manifest.record_contract)
      ? manifest.record_contract.filter((entry): entry is string => typeof entry === "string")
      : null,
    source_host: typeof manifest.source_host === "string" ? manifest.source_host : null,
    allowed_exam_years: Array.isArray(manifest.allowed_exam_years)
      ? manifest.allowed_exam_years.filter((entry): entry is number => typeof entry === "number")
      : null
  };
}

/**
 * Freshness is a claim about how the bytes were obtained, so it is decided from
 * acquisition evidence rather than from row well-formedness. A manifest may
 * assert `direct_fetch_status: PASS`; that assertion alone only ever yields
 * UNVERIFIED, because nothing in the two B2 inputs independently proves a live
 * fetch happened at `fetched_at`.
 */
function classifyFreshness(
  manifest: unknown,
  input: ValidateExamSnapshotInput,
  findings: ExamSnapshotFinding[]
): ExamSnapshotValidationReport["freshness"] {
  const evidence: string[] = [];
  const conflicts: string[] = [];

  const acquisition = isRecord(manifest) && isRecord(manifest.acquisition) ? manifest.acquisition : {};
  const directFetchStatus = textOf(acquisition.direct_fetch_status);
  const method = textOf(acquisition.method);
  const failedUrls = isRecord(manifest) && Array.isArray(manifest.failed_urls) ? manifest.failed_urls : [];

  if (directFetchStatus) evidence.push(`manifest.acquisition.direct_fetch_status="${directFetchStatus}"`);
  if (method) evidence.push(`manifest.acquisition.method="${method}"`);
  evidence.push(`manifest.failed_urls=${failedUrls.length}`);

  const acquisitionText = `${directFetchStatus} ${method}`.toLowerCase();
  const fallbackMarker = /(dns|fallback|unavailable|cache|snapshot index|indexed|degraded|offline)/.test(
    acquisitionText
  );
  const claimsDirect = /pass/.test(acquisitionText) && /direct/.test(acquisitionText);

  let status: "VERIFIED" | "UNVERIFIED" = "UNVERIFIED";
  let reason = "manifest self-assertion only; no independent live-fetch evidence among the B2 inputs";

  if (input.liveFetchEvidence) {
    status = "VERIFIED";
    reason = "independent live-fetch evidence supplied";
  }
  if (fallbackMarker) {
    status = "UNVERIFIED";
    reason = "manifest acquisition text contains a non-direct-fetch/fallback marker";
  }
  if (claimsDirect && !input.liveFetchEvidence) {
    evidence.push("manifest claims direct fetch; B2 does not upgrade freshness on a self-assertion");
  }
  if (input.freshnessOverride) {
    if (input.freshnessOverride !== status) {
      conflicts.push(`owner override ${input.freshnessOverride} supersedes computed ${status}`);
    }
    status = input.freshnessOverride;
    reason = input.freshnessOverrideReason ?? "owner-issued freshness verdict";
  }
  if (claimsDirect && status === "UNVERIFIED") {
    conflicts.push(`manifest asserts direct fetch (PASS/HOST_DIRECT) but freshness is ${status}`);
  }

  if (status === "UNVERIFIED") {
    findings.push({
      code: "DATA_FRESHNESS_UNVERIFIED",
      severity: "warning",
      message: `DATA_FRESHNESS=UNVERIFIED — ${reason}`
    });
  }

  return { status, reason, manifest_claim: claimsDirect ? "direct_fetch" : fallbackMarker ? "fallback" : null, evidence, conflicts };
}

export function validateExamSnapshot(input: ValidateExamSnapshotInput): ExamSnapshotValidationReport {
  const findings: ExamSnapshotFinding[] = [];
  const expectedRows = input.expectedRows ?? EXAM_COURSE_SNAPSHOT_EXPECTED_ROWS;
  const manifest = collectManifest(input.manifest);
  const contract = manifest.record_contract ?? [...EXAM_COURSE_RECORD_COLUMNS];

  if (manifest.record_contract) {
    const declared = manifest.record_contract.join(",");
    const expected = EXAM_COURSE_RECORD_COLUMNS.join(",");
    if (declared !== expected) {
      findings.push({
        code: "RECORD_CONTRACT_MISMATCH",
        severity: "error",
        message: `manifest record_contract [${declared}] != repository columns [${expected}]`
      });
    }
  } else {
    findings.push({
      code: "RECORD_CONTRACT_MISSING",
      severity: "warning",
      message: "manifest declares no record_contract; repository column order is the fallback"
    });
  }

  if (manifest.schema_version !== EXAM_COURSE_SNAPSHOT_SCHEMA_VERSION) {
    findings.push({
      code: "SNAPSHOT_SCHEMA_VERSION_UNEXPECTED",
      severity: "warning",
      message: `manifest schema_version="${String(manifest.schema_version)}" (expected ${EXAM_COURSE_SNAPSHOT_SCHEMA_VERSION})`
    });
  }
  if (manifest.declared_rows !== null && manifest.declared_rows !== input.rows.length) {
    findings.push({
      code: "MANIFEST_ROWS_MISMATCH",
      severity: "error",
      message: `manifest rows=${manifest.declared_rows} but snapshot contains ${input.rows.length}`
    });
  }
  if (manifest.source_host !== null && !EXAM_COURSE_ALLOWED_SOURCE_HOSTS.includes(manifest.source_host)) {
    findings.push({
      code: "MANIFEST_SOURCE_HOST_OUT_OF_RANGE",
      severity: "error",
      message: `manifest source_host="${manifest.source_host}" is not an allowed host`
    });
  }
  if (manifest.allowed_exam_years && manifest.allowed_exam_years.join(",") !== EXAM_COURSE_ALLOWED_YEARS.join(",")) {
    findings.push({
      code: "MANIFEST_EXAM_YEARS_MISMATCH",
      severity: "warning",
      message: `manifest allowed_exam_years=[${manifest.allowed_exam_years.join(",")}] != [${EXAM_COURSE_ALLOWED_YEARS.join(",")}]`
    });
  }

  if (input.rows.length !== expectedRows) {
    findings.push({
      code: "ROW_COUNT_MISMATCH",
      severity: "error",
      message: `expected ${expectedRows} rows, received ${input.rows.length}`
    });
  }

  const yearsSeen = new Set<number>();
  const categoriesSeen = new Set<string>();
  const hostsSeen = new Set<string>();
  const keysSeen = new Set<string>();
  const duplicateKeys: string[] = [];
  const urlKeys = new Map<string, number>();
  const rawSourceUrls: string[] = [];
  let hashFormatValid = 0;
  let hashReproducible = 0;
  let hashVariant: string | null = null;

  input.rows.forEach((raw, index) => {
    if (!isRecord(raw)) {
      findings.push({
        code: "ROW_NOT_OBJECT",
        severity: "error",
        message: `row ${index} is not an object`,
        row_index: index
      });
      return;
    }

    const record = raw as Partial<ExamCourseRecord>;
    for (const column of contract) {
      if (!(column in raw)) {
        findings.push({
          code: "ROW_FIELD_MISSING",
          severity: "error",
          message: `row ${index} is missing ${column}`,
          row_index: index
        });
      }
    }
    for (const key of Object.keys(raw)) {
      if (!contract.includes(key)) {
        findings.push({
          code: "ROW_FIELD_UNEXPECTED",
          severity: "warning",
          message: `row ${index} carries undeclared field ${key}`,
          row_index: index
        });
      }
    }

    if (typeof record.exam_year === "number") {
      yearsSeen.add(record.exam_year);
      if (!EXAM_COURSE_ALLOWED_YEARS.includes(record.exam_year)) {
        findings.push({
          code: "EXAM_YEAR_OUT_OF_RANGE",
          severity: "error",
          message: `row ${index} exam_year=${record.exam_year} not in [${EXAM_COURSE_ALLOWED_YEARS.join(", ")}]`,
          row_index: index
        });
      }
    } else {
      findings.push({
        code: "EXAM_YEAR_OUT_OF_RANGE",
        severity: "error",
        message: `row ${index} exam_year is not a number`,
        row_index: index
      });
    }

    const category = typeof record.category === "string" ? record.category : "";
    if (category) categoriesSeen.add(category);
    if (!EXAM_COURSE_ALLOWED_CATEGORIES.includes(category)) {
      findings.push({
        code: "CATEGORY_OUT_OF_RANGE",
        severity: "error",
        message: `row ${index} category="${category}" not in [${EXAM_COURSE_ALLOWED_CATEGORIES.join(", ")}]`,
        row_index: index
      });
    }

    const courseCode = typeof record.course_code === "string" ? record.course_code : "";
    if (!COURSE_CODE_PATTERN.test(courseCode)) {
      findings.push({
        code: "COURSE_CODE_INVALID",
        severity: "error",
        message: `row ${index} course_code="${courseCode}" violates the uppercase identifier CHECK of exam_courses`,
        row_index: index
      });
    }

    const courseName = typeof record.course_name === "string" ? record.course_name : "";
    if (courseName.length === 0 || courseName.length > 512) {
      findings.push({
        code: "COURSE_NAME_INVALID",
        severity: "error",
        message: `row ${index} course_name length ${courseName.length} is outside 1..512`,
        row_index: index
      });
    }
    const courseContent = typeof record.course_content === "string" ? record.course_content : "";
    if (courseContent.length > 20000) {
      findings.push({
        code: "COURSE_CONTENT_TOO_LARGE",
        severity: "error",
        message: `row ${index} course_content length ${courseContent.length} exceeds 20000`,
        row_index: index
      });
    }

    const sourceUrl = typeof record.source_url === "string" ? record.source_url : "";
    if (sourceUrl) rawSourceUrls.push(sourceUrl);
    let host = "";
    try {
      const parsed = new URL(sourceUrl);
      host = parsed.host;
      if (parsed.protocol !== "https:") {
        findings.push({
          code: "SOURCE_URL_NOT_HTTPS",
          severity: "error",
          message: `row ${index} source_url protocol=${parsed.protocol}`,
          row_index: index
        });
      }
    } catch {
      findings.push({
        code: "SOURCE_URL_UNPARSEABLE",
        severity: "error",
        message: `row ${index} source_url="${sourceUrl}" is not an absolute URL`,
        row_index: index
      });
    }
    if (host) {
      hostsSeen.add(host);
      if (!EXAM_COURSE_ALLOWED_SOURCE_HOSTS.includes(host.toLowerCase())) {
        findings.push({
          code: "SOURCE_HOST_OUT_OF_RANGE",
          severity: "error",
          message: `row ${index} source_url host="${host}" is not ${EXAM_COURSE_ALLOWED_SOURCE_HOSTS.join("/")}`,
          row_index: index
        });
      }
      if (host !== host.toLowerCase()) {
        findings.push({
          code: "SOURCE_HOST_NOT_CANONICAL",
          severity: "error",
          message: `row ${index} source_url host="${host}" must be lowercase to satisfy the table CHECK`,
          row_index: index
        });
      }
    }

    const fetchedAt = typeof record.fetched_at === "string" ? record.fetched_at : "";
    if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) {
      findings.push({
        code: "FETCHED_AT_UNPARSEABLE",
        severity: "error",
        message: `row ${index} fetched_at="${fetchedAt}" is not an ISO-8601 timestamp`,
        row_index: index
      });
    }

    const contentHash = typeof record.content_hash === "string" ? record.content_hash : "";
    if (SHA256_HEX_PATTERN.test(contentHash)) {
      hashFormatValid += 1;
    } else {
      findings.push({
        code: "CONTENT_HASH_NOT_SHA256",
        severity: "error",
        message: `row ${index} content_hash="${contentHash}" is not 64 lowercase hex characters`,
        row_index: index
      });
    }

    if (typeof record.exam_year === "number" && courseCode) {
      const key = examCourseKey({ exam_year: record.exam_year, course_code: courseCode });
      if (keysSeen.has(key)) {
        duplicateKeys.push(key);
        findings.push({
          code: "DUPLICATE_NATURAL_KEY",
          severity: "error",
          message: `row ${index} repeats key ${key}; the upsert would collapse it into the earlier row`,
          row_index: index
        });
      }
      keysSeen.add(key);
    }

    if (sourceUrl) {
      const urlKey = sourceUrl.toLowerCase();
      const firstSeenAt = urlKeys.get(urlKey);
      if (firstSeenAt === undefined) {
        urlKeys.set(urlKey, index);
      } else {
        findings.push({
          code: "DUPLICATE_SOURCE_URL",
          severity: "error",
          message: `row ${index} and row ${firstSeenAt} point at the same source_url`,
          row_index: index
        });
      }
    }

    // Recomputation only runs on structurally complete rows: a half-populated
    // row already produced field errors and would throw inside the recipe.
    const hashRecipeRecord: ExamCourseRecord | null =
      SHA256_HEX_PATTERN.test(contentHash) &&
      typeof record.exam_year === "number" &&
        [record.category, record.course_code, record.course_name, record.course_content, record.source_url].every(
          (value) => typeof value === "string"
        )
        ? ({ ...record, course_content: record.course_content ?? "" } as ExamCourseRecord)
        : null;

    if (hashRecipeRecord) {
      const match = matchExamCourseContentHash(hashRecipeRecord);
      if (match) {
        hashReproducible += 1;
        hashVariant = hashVariant === null ? match.variant : hashVariant === match.variant ? hashVariant : "mixed";
      }
    }
  });

  if (hashReproducible < input.rows.length) {
    findings.push({
      code: "CONTENT_HASH_NOT_REPRODUCIBLE",
      severity: "warning",
      message: `content_hash reproduces for ${hashReproducible}/${input.rows.length} rows under the declared recipe; incremental updates rely on the stored value, not on recomputation`
    });
  }

  // Casing variance must be measured on the *original* URLs: comparing the
  // already-lowercased dedupe keys would make every path look identical.
  const pathCasings = new Set(rawSourceUrls.map((url) => url.split(/[?#]/)[0]));
  const pathIdentities = new Set(rawSourceUrls.map((url) => url.split(/[?#]/)[0].toLowerCase()));
  if (pathCasings.size > pathIdentities.size) {
    findings.push({
      code: "SOURCE_URL_CASE_INCONSISTENT",
      severity: "warning",
      message: `source_url paths differ only by letter case (${pathCasings.size} casings over ${pathIdentities.size} logical paths); host match is uniform but provenance formatting is not`
    });
  }

  const duplicateKeyList = [...new Set(duplicateKeys)];
  const freshness = classifyFreshness(input.manifest, input, findings);

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;

  return {
    ok: errors === 0,
    errors,
    warnings,
    rows: input.rows.length,
    expected_rows: expectedRows,
    exam_years: [...yearsSeen].sort((left, right) => left - right),
    categories: [...categoriesSeen].sort(),
    source_hosts: [...hostsSeen].sort(),
    unique_keys: keysSeen.size,
    duplicate_keys: duplicateKeyList,
    content_hash: {
      algorithm: EXAM_COURSE_CONTENT_HASH_ALGORITHM,
      format_valid: hashFormatValid,
      reproducible: hashReproducible,
      matched_variant: hashVariant
    },
    manifest,
    freshness,
    findings
  };
}
