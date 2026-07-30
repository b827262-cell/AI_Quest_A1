import type Database from "better-sqlite3";
import { createDbHandle, resolveDbPath } from "./client";
import { newId } from "./repositories/util";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT,
    description TEXT,
    cover_url TEXT,
    category TEXT NOT NULL DEFAULT '未分類',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS book_files (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'source_document',
    related_file_id TEXT,
    parse_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS book_contents (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    file_id TEXT,
    chapter_id TEXT,
    page_number INTEGER,
    content_text TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS book_chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    page_start INTEGER,
    page_end INTEGER,
    level INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    user_agent TEXT,
    os_name TEXT,
    os_version TEXT,
    browser_name TEXT,
    browser_version TEXT,
    device_type TEXT,
    device_vendor TEXT,
    device_model TEXT,
    last_ip_address TEXT,
    last_ip_country TEXT,
    last_ip_region TEXT,
    last_ip_city TEXT,
    last_ip_source TEXT,
    risk_level TEXT NOT NULL DEFAULT 'safe',
    is_blocked INTEGER NOT NULL DEFAULT 0,
    blocked_at TEXT,
    blocked_reason TEXT,
    risk_note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pdf_access_logs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    viewed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS book_ai_jobs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    input_json TEXT,
    output_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS book_qa_logs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_id TEXT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    context_json TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS smart_book_notes (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_id TEXT,
    page_number INTEGER,
    type TEXT NOT NULL DEFAULT 'text',
    title TEXT NOT NULL DEFAULT '',
    content TEXT,
    canvas_data TEXT,
    canvas_image_url TEXT,
    source_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_request_logs (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    visitor_id TEXT,
    visitor_ip_hash TEXT,
    request_source TEXT NOT NULL,
    question TEXT NOT NULL,
    question_length INTEGER NOT NULL,
    subject TEXT NOT NULL,
    task_type TEXT NOT NULL,
    complexity TEXT NOT NULL,
    routing_provider TEXT NOT NULL,
    routing_model TEXT,
    routing_reason TEXT NOT NULL,
    provider_attempts_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    error_code TEXT,
    diagnostics_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    latency_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_usage_logs (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    credential_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    -- Q&A detail (spec §2): redacted, bounded; NULL on legacy rows.
    question_text TEXT,
    answer_text TEXT,
    -- Token breakdown (spec §6): cached/thinking are subsets, never additive.
    cached_input_tokens INTEGER,
    thinking_tokens INTEGER,
    -- Cost breakdown (spec §6): integer micro-USD, never floats.
    input_cost_microusd INTEGER NOT NULL DEFAULT 0,
    cached_input_cost_microusd INTEGER NOT NULL DEFAULT 0,
    output_cost_microusd INTEGER NOT NULL DEFAULT 0,
    total_cost_microusd INTEGER NOT NULL DEFAULT 0,
    -- Pricing provenance (spec §5.3): immutable snapshot captured per request.
    pricing_source TEXT,
    pricing_version TEXT,
    pricing_snapshot_json TEXT,
    usage_source TEXT,
    estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    actual_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    finish_reason TEXT,
    pool_id TEXT,
    logical_model_id TEXT,
    estimated INTEGER,
    overage_tokens INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS guest_ask_answers (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    visitor_ip_hash TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    finish_reason TEXT,
    completion_json TEXT,
    created_at TEXT NOT NULL,
    -- Columns added for token-based recovery + retention (spec §2, §3).
    -- visitor_ip_hash is retained for back-compat but no longer read; new rows
    -- populate visitor_ip_hmac instead. Legacy rows have NULL here and cannot
    -- be recovered (they predate recovery tokens).
    visitor_ip_hmac TEXT,
    recovery_token_digest TEXT,
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_configs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_router_provider INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_credentials (
    id TEXT PRIMARY KEY,
    provider_config_id TEXT NOT NULL,
    name TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    masked_api_key TEXT NOT NULL,
    key_fingerprint TEXT NOT NULL UNIQUE,
    base_url TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER NOT NULL DEFAULT 100,
    weight INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    cooldown_until TEXT,
    last_tested_at TEXT,
    last_test_status TEXT,
    last_test_latency_ms INTEGER,
    billing_mode TEXT NOT NULL DEFAULT 'unknown',
    region TEXT,
    endpoint_profile TEXT,
    usage_scope TEXT NOT NULL DEFAULT 'unknown',
    production_authorized INTEGER NOT NULL DEFAULT 0,
    provider_health TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_credential_model_quotas (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    model TEXT NOT NULL,
    rpm_limit INTEGER,
    tpm_limit INTEGER,
    rpd_limit INTEGER,
    requests_this_minute INTEGER NOT NULL DEFAULT 0,
    tokens_this_minute INTEGER NOT NULL DEFAULT 0,
    requests_today INTEGER NOT NULL DEFAULT 0,
    minute_reset_at TEXT NOT NULL,
    daily_reset_at TEXT NOT NULL,
    reset_timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
    usage_source TEXT NOT NULL DEFAULT 'system_estimated',
    -- Pricing config (spec §5.1): DB-backed, authoritative per model.
    currency TEXT,
    service_tier TEXT,
    input_price_usd_per_million REAL,
    output_price_usd_per_million REAL,
    cached_input_price_usd_per_million REAL,
    cache_storage_usd_per_million_token_hour REAL,
    pricing_effective_at TEXT,
    pricing_source TEXT,
    pricing_unavailable INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_admin_audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_runs (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    dataset_version INTEGER NOT NULL,
    execution_mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    idempotency_key TEXT UNIQUE,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    total_cases INTEGER NOT NULL DEFAULT 0,
    passed_cases INTEGER NOT NULL DEFAULT 0,
    failed_cases INTEGER NOT NULL DEFAULT 0,
    pass_rate REAL NOT NULL DEFAULT 0,
    average_score REAL NOT NULL DEFAULT 0,
    average_duration_ms REAL NOT NULL DEFAULT 0,
    p50_duration_ms REAL NOT NULL DEFAULT 0,
    p95_duration_ms REAL NOT NULL DEFAULT 0,
    total_model_calls INTEGER NOT NULL DEFAULT 0,
    average_model_calls REAL NOT NULL DEFAULT 0,
    total_input_tokens INTEGER,
    total_output_tokens INTEGER,
    total_tokens INTEGER,
    conflict_rate REAL NOT NULL DEFAULT 0,
    unresolved_rate REAL NOT NULL DEFAULT 0,
    baseline_run_id TEXT,
    regression_issue_count INTEGER NOT NULL DEFAULT 0,
    created_by_admin_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_metrics (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    dimension_value TEXT NOT NULL,
    count INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    pass_rate REAL NOT NULL,
    average_score REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_issues (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    category TEXT NOT NULL,
    expected_kind TEXT NOT NULL,
    score REAL NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    safe_summary TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_settings (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    evaluation_pool_id TEXT,
    allowed_dataset_ids_json TEXT NOT NULL DEFAULT '[]',
    allowed_logical_model_ids_json TEXT NOT NULL DEFAULT '[]',
    allowed_provider_ids_json TEXT NOT NULL DEFAULT '[]',
    max_cases_per_run INTEGER NOT NULL DEFAULT 0,
    max_tokens_per_run INTEGER NOT NULL DEFAULT 0,
    max_tokens_per_day INTEGER NOT NULL DEFAULT 0,
    max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
    require_dry_run INTEGER NOT NULL DEFAULT 1,
    require_explicit_confirmation INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by_admin_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_daily_usage (
    usage_date TEXT PRIMARY KEY,
    consumed_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_token_pools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    traffic_class TEXT NOT NULL DEFAULT 'evaluation',
    capacity_tokens INTEGER NOT NULL,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_budget_reservations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    pool_id TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    actual_tokens INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    settled_at TEXT,
    released_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_preflights (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    dataset_version INTEGER NOT NULL,
    selected_case_count INTEGER NOT NULL,
    max_token_budget INTEGER NOT NULL,
    logical_model_ids_json TEXT NOT NULL,
    provider_ids_json TEXT NOT NULL,
    estimated_minimum_model_calls INTEGER NOT NULL,
    estimated_maximum_model_calls INTEGER NOT NULL,
    estimated_maximum_tokens INTEGER NOT NULL,
    evaluation_pool_remaining_tokens INTEGER NOT NULL,
    daily_remaining_tokens INTEGER NOT NULL,
    blockers_json TEXT NOT NULL DEFAULT '[]',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    confirmation_digest TEXT,
    allowed INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_governance_settings (
    id TEXT PRIMARY KEY,
    retention_json TEXT NOT NULL DEFAULT '{}',
    regression_alert_json TEXT NOT NULL DEFAULT '{}',
    budget_alert_json TEXT NOT NULL DEFAULT '{}',
    scheduler_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by_admin_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_schedules (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    dataset_id TEXT NOT NULL,
    dataset_version INTEGER NOT NULL,
    execution_mode TEXT NOT NULL,
    cadence TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    baseline_policy TEXT NOT NULL,
    fixed_baseline_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    scheduled_window TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'running',
    run_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    safe_error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(schedule_id, scheduled_window)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_alert_policies (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    minimum_sample_size INTEGER NOT NULL DEFAULT 1,
    pass_rate_drop_percentage_points REAL,
    category_pass_rate_drop_percentage_points REAL,
    unresolved_rate_increase_percentage_points REAL,
    conflict_rate_increase_percentage_points REAL,
    average_model_calls_increase REAL,
    p95_latency_increase_ms REAL,
    consecutive_failures_required INTEGER NOT NULL DEFAULT 1,
    evaluation_pool_remaining_threshold INTEGER,
    daily_budget_remaining_threshold INTEGER,
    updated_at TEXT NOT NULL,
    updated_by_admin_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_alerts (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    schedule_id TEXT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    safe_summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    resolved_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_evaluation_retention_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'previewed',
    candidate_ids_json TEXT NOT NULL DEFAULT '[]',
    candidate_digest TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    safe_error_code TEXT,
    created_by_admin_id TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_multi_model_pilot_settings (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    traffic_percentage INTEGER NOT NULL DEFAULT 0,
    allowed_task_categories_json TEXT NOT NULL DEFAULT '[]',
    allow_verification INTEGER NOT NULL DEFAULT 1,
    allow_adjudication INTEGER NOT NULL DEFAULT 0,
    max_model_calls_per_request INTEGER NOT NULL DEFAULT 2,
    pilot_version TEXT NOT NULL DEFAULT 'phase-5a-default',
    stop_policy_json TEXT NOT NULL DEFAULT '{}',
    readiness_review_json TEXT NOT NULL DEFAULT '{}',
    auto_stopped_at TEXT,
    auto_stop_reason TEXT,
    updated_at TEXT NOT NULL,
    updated_by_admin_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_multi_model_pilot_metrics (
    id TEXT PRIMARY KEY,
    window_key TEXT NOT NULL UNIQUE,
    traffic_class TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    primary_only_count INTEGER NOT NULL DEFAULT 0,
    verification_count INTEGER NOT NULL DEFAULT 0,
    adjudication_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    provider_failure_count INTEGER NOT NULL DEFAULT 0,
    budget_rejection_count INTEGER NOT NULL DEFAULT 0,
    context_window_rejection_count INTEGER NOT NULL DEFAULT 0,
    total_model_calls INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    p50_latency_ms REAL NOT NULL DEFAULT 0,
    p95_latency_ms REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_budget_policies (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    daily_token_limit INTEGER NOT NULL DEFAULT 1000000,
    daily_cost_limit_micro_usd INTEGER NOT NULL DEFAULT 10000000,
    warning_percentage INTEGER NOT NULL DEFAULT 80,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_daily_usage (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    actual_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_budget_reservations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    date TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    estimated_cost_micro_usd INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_logical_models (
    id TEXT PRIMARY KEY,
    logical_model_id TEXT NOT NULL UNIQUE,
    provider_id TEXT NOT NULL,
    provider_config_id TEXT,
    provider_model_name TEXT NOT NULL,
    context_window_tokens INTEGER NOT NULL,
    max_input_tokens INTEGER,
    max_output_tokens INTEGER NOT NULL,
    supports_thinking INTEGER NOT NULL DEFAULT 0,
    tokenizer_type TEXT,
    tokenizer_version TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_token_pools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pool_type TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
    daily_limit INTEGER NOT NULL,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    warning_threshold INTEGER NOT NULL DEFAULT 60,
    throttle_threshold INTEGER NOT NULL DEFAULT 80,
    critical_threshold INTEGER NOT NULL DEFAULT 90,
    reset_at TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_model_daily_limits (
    id TEXT PRIMARY KEY,
    logical_model_id TEXT NOT NULL UNIQUE,
    pool_id TEXT NOT NULL,
    daily_limit INTEGER NOT NULL,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 100,
    fallback_logical_model_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    allow_second_model_verification INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_token_pool_reservations (
    id TEXT PRIMARY KEY,
    reservation_key TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    logical_model_id TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    actual_tokens INTEGER,
    overage INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    settled_at TEXT,
    released_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_book_files_book ON book_files(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_book_contents_book ON book_contents(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_book_contents_chapter ON book_contents(chapter_id)`,
  `CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pdf_access_logs_book ON pdf_access_logs(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pdf_access_logs_session ON pdf_access_logs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_book_ai_jobs_book ON book_ai_jobs(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_book_qa_logs_book ON book_qa_logs(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_smart_book_notes_book ON smart_book_notes(book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_request_logs_created ON ai_request_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_request_logs_status ON ai_request_logs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_request_logs_provider ON ai_request_logs(routing_provider)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_request_logs_request_id ON ai_request_logs(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_request ON ai_usage_logs(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_guest_ask_answers_created ON guest_ask_answers(created_at)`,
  // idx_guest_ask_answers_expires is created below, after the expires_at
  // column is added, because databases with the previous schema lack it.
  `CREATE INDEX IF NOT EXISTS idx_ai_provider_credentials_config ON ai_provider_credentials(provider_config_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_provider_credentials_select ON ai_provider_credentials(provider_config_id, status, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_credential_model_quotas_credential ON ai_credential_model_quotas(credential_id, enabled)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credential_model_quotas_model ON ai_credential_model_quotas(credential_id, model COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_admin_audit_logs_created ON ai_admin_audit_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_runs_dataset_created ON ai_evaluation_runs(dataset_id, dataset_version, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_runs_mode_created ON ai_evaluation_runs(execution_mode, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_runs_status_created ON ai_evaluation_runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_metrics_run_dimension ON ai_evaluation_metrics(run_id, dimension)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_issues_run_severity ON ai_evaluation_issues(run_id, severity)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_runs_live_status ON ai_evaluation_runs(execution_mode, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_budget_reservations_run ON ai_evaluation_budget_reservations(run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_preflights_admin_created ON ai_evaluation_preflights(admin_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_schedules_enabled ON ai_evaluation_schedules(enabled, scheduled_time)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_evaluation_schedule_runs_window ON ai_evaluation_schedule_runs(schedule_id, scheduled_window)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_schedule_runs_status ON ai_evaluation_schedule_runs(status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_alerts_status_created ON ai_evaluation_alerts(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_alerts_run ON ai_evaluation_alerts(run_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluation_retention_status ON ai_evaluation_retention_runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_pilot_metrics_traffic_window ON ai_multi_model_pilot_metrics(traffic_class, window_key)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created ON ai_usage_logs(created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_budget_policies_scope ON ai_budget_policies(scope_type, scope_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_daily_usage_scope ON ai_daily_usage(date, scope_type, scope_key)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_request ON ai_budget_reservations(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_status ON ai_budget_reservations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_logical_models_enabled ON ai_logical_models(enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_token_pools_type ON ai_token_pools(pool_type)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_model_daily_limits_pool ON ai_model_daily_limits(pool_id, enabled, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_token_pool_reservations_request ON ai_token_pool_reservations(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_token_pool_reservations_pool ON ai_token_pool_reservations(pool_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_request_logs_request_id_unique ON ai_request_logs(request_id)`,
  // ----- OpenAI Credential daily ledger (per-key daily quota) ---------------
  `CREATE TABLE IF NOT EXISTS ai_credential_daily_limits (
    id TEXT PRIMARY KEY NOT NULL,
    credential_id TEXT NOT NULL,
    daily_token_limit INTEGER,
    daily_cost_limit_micro_usd INTEGER,
    timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
    warning_threshold INTEGER NOT NULL DEFAULT 80,
    enabled INTEGER NOT NULL DEFAULT 0,
    reset_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_credential_daily_usage (
    id TEXT PRIMARY KEY NOT NULL,
    credential_id TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
    provider_config_id TEXT NOT NULL,
    provider_model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    actual_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    reserved_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    cost_source TEXT NOT NULL DEFAULT 'unconfigured',
    last_used_at TEXT,
    reset_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_credential_daily_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    reservation_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    credential_id TEXT NOT NULL,
    provider_config_id TEXT NOT NULL,
    provider_model TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    actual_tokens INTEGER,
    estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    actual_cost_micro_usd INTEGER,
    overage INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    cost_status TEXT NOT NULL DEFAULT 'unconfigured',
    settled_at TEXT,
    released_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credential_daily_limits_credential ON ai_credential_daily_limits(credential_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credential_daily_usage_key ON ai_credential_daily_usage(credential_id, usage_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_credential_daily_usage_date ON ai_credential_daily_usage(usage_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_credential_daily_usage_config ON ai_credential_daily_usage(provider_config_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credential_daily_reservations_key ON ai_credential_daily_reservations(reservation_key)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_credential_daily_reservations_credential ON ai_credential_daily_reservations(credential_id, usage_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_credential_daily_reservations_request ON ai_credential_daily_reservations(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_credential_daily_reservations_status ON ai_credential_daily_reservations(status, usage_date)`
];

/**
 * Add a column to an existing table only when it is missing. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so we probe `PRAGMA table_info` first. This keeps
 * migrations non-destructive and safe to re-run against older databases.
 */
function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function providerInstanceSlug(label: string, id: string, used: Set<string>): string {
  const base = label
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || `provider-${id.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(-16) || "instance"}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, Math.max(1, 64 - String(suffix).length - 1))}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

/**
 * Replace the original UNIQUE(provider) table constraint with a stable,
 * instance-level slug. The rebuild is required because SQLite cannot drop a
 * table-level UNIQUE constraint in place. All provider rows are copied and
 * only a missing slug is derived from the existing display name.
 */
function migrateProviderInstanceIdentity(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(ai_provider_configs)").all() as Array<{ name: string; notnull: number }>;
  const hasSlug = columns.some((column) => column.name === "slug");
  const slugIsRequired = columns.find((column) => column.name === "slug")?.notnull === 1;
  const uniqueProvider = (sqlite.prepare("PRAGMA index_list(ai_provider_configs)").all() as Array<{ name: string; unique: number }>)
    .filter((index) => index.unique === 1)
    .some((index) => (sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string | null }>).some((column) => column.name === "provider"));
  if (hasSlug && slugIsRequired && !uniqueProvider) {
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_slug ON ai_provider_configs(slug COLLATE NOCASE)");
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_display_name ON ai_provider_configs(display_name COLLATE NOCASE)");
    return;
  }

  if (!hasSlug) addColumnIfMissing(sqlite, "ai_provider_configs", "slug", "slug TEXT");
  const rows = sqlite.prepare("SELECT id, display_name, slug FROM ai_provider_configs ORDER BY created_at, id").all() as Array<{ id: string; display_name: string; slug: string | null }>;
  const used = new Set<string>();
  const updateSlug = sqlite.prepare("UPDATE ai_provider_configs SET slug = ? WHERE id = ?");
  for (const row of rows) {
    const existing = row.slug?.trim().toLowerCase();
    const slug = existing && !used.has(existing) ? (used.add(existing), existing) : providerInstanceSlug(row.display_name, row.id, used);
    updateSlug.run(slug, row.id);
  }

  sqlite.exec("ALTER TABLE ai_provider_configs RENAME TO ai_provider_configs_legacy");
  sqlite.exec(`CREATE TABLE ai_provider_configs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_router_provider INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`);
  sqlite.exec(`INSERT INTO ai_provider_configs
    (id, provider, slug, display_name, base_url, model, enabled, is_default,
     is_router_provider, priority, created_at, updated_at, deleted_at)
    SELECT id, provider, slug, display_name, base_url, model, enabled, is_default,
      is_router_provider, priority, created_at, updated_at, deleted_at
    FROM ai_provider_configs_legacy`);
  sqlite.exec("DROP TABLE ai_provider_configs_legacy");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_slug ON ai_provider_configs(slug COLLATE NOCASE)");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_display_name ON ai_provider_configs(display_name COLLATE NOCASE)");
}

function migrationLocalDate(now: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function migrationLocalMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let i = 0; i < 4; i += 1) {
    const local = migrationLocalDate(new Date(candidate), timezone);
    candidate = target - (Date.UTC(local.year, local.month - 1, local.day) - candidate);
  }
  return new Date(candidate);
}

function migrationDailyReset(now: Date, timezone = "Asia/Taipei"): string {
  const current = migrationLocalDate(now, timezone);
  const next = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return migrationLocalMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone).toISOString();
}

/**
 * Credential.model predates the per-model quota table. Promote it to the
 * canonical default quota exactly once. Existing same-name quotas are reused.
 */
function backfillCredentialDefaultModels(sqlite: Database.Database): void {
  const now = new Date();
  const minuteResetAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000).toISOString();
  const dailyResetAt = migrationDailyReset(now);
  const credentials = sqlite.prepare(
    "SELECT id, model FROM ai_provider_credentials"
  ).all() as Array<{ id: string; model: string | null }>;
  const findQuota = sqlite.prepare(
    "SELECT id, model FROM ai_credential_model_quotas WHERE credential_id = ? AND lower(trim(model)) = lower(trim(?)) LIMIT 1"
  );
  const findExistingDefault = sqlite.prepare(
    "SELECT id, model FROM ai_credential_model_quotas WHERE credential_id = ? AND enabled = 1 ORDER BY created_at, id LIMIT 1"
  );
  const clearDefaults = sqlite.prepare(
    "UPDATE ai_credential_model_quotas SET is_default = 0, updated_at = ? WHERE credential_id = ?"
  );
  const setDefault = sqlite.prepare(
    "UPDATE ai_credential_model_quotas SET is_default = 1, updated_at = ? WHERE id = ?"
  );
  const insertQuota = sqlite.prepare(`
    INSERT INTO ai_credential_model_quotas
      (id, credential_id, model, rpm_limit, tpm_limit, rpd_limit,
       requests_this_minute, tokens_this_minute, requests_today,
       minute_reset_at, daily_reset_at, reset_timezone, usage_source,
       enabled, is_default, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, 0, 0, 0, ?, ?, 'Asia/Taipei',
      'system_estimated', 1, 1, ?, ?)
  `);
  const updateCredentialModel = sqlite.prepare(
    "UPDATE ai_provider_credentials SET model = ?, updated_at = ? WHERE id = ?"
  );

  for (const credential of credentials) {
    const model = credential.model?.trim();
    const legacyQuota = model ? findQuota.get(credential.id, model) as { id: string; model: string } | undefined : undefined;
    const fallbackQuota = findExistingDefault.get(credential.id) as { id: string; model: string } | undefined;
    const target = legacyQuota ?? fallbackQuota;
    clearDefaults.run(now.toISOString(), credential.id);
    if (target) {
      setDefault.run(now.toISOString(), target.id);
      if (!model) updateCredentialModel.run(target.model, now.toISOString(), credential.id);
    } else if (model) {
      const createdAt = now.toISOString();
      insertQuota.run(newId("aiq"), credential.id, model, minuteResetAt, dailyResetAt, createdAt, createdAt);
    }
  }
}

/**
 * Idempotently seed the Token Pool system defaults: two pools (shared 2,500,000
 * and sol 200,000), five logical models, and their per-model daily limits.
 *
 * The four shared-pool models have fixed hard caps totalling 1,900,000; the
 * remaining 600,000 of the 2,500,000 pool is "unallocated capacity" (shown as
 * such in the UI, NOT borrowable — models never exceed their own daily cap).
 * GPT-5.6 Sol is an independent pool. No speculative Claude free quota is
 * created (Anthropic will read official rate-limit headers on future hookup).
 *
 * Idempotent: each insert is guarded by a prior SELECT, so re-running migrations
 * never duplicates or resets already-configured rows. `provider_model_name`
 * defaults to a placeholder the admin must overwrite with the real API model.
 */
function seedLogicalModelsAndPools(sqlite: Database.Database): void {
  const now = new Date().toISOString();
  const resetAt = migrationDailyReset(new Date());

  const findPool = sqlite.prepare("SELECT id FROM ai_token_pools WHERE pool_type = ?");
  const insertPool = sqlite.prepare(`
    INSERT INTO ai_token_pools
      (id, name, pool_type, timezone, daily_limit, used_tokens, reserved_tokens,
       warning_threshold, throttle_threshold, critical_threshold, reset_at,
       enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'Asia/Taipei', ?, 0, 0, 60, 80, 90, ?, 1, ?, ?)
  `);

  const sharedExists = findPool.get("shared");
  if (!sharedExists) {
    insertPool.run(newId("aitp"), "OpenAI 共用每日額度池", "shared", 2_500_000, resetAt, now, now);
  } else {
    // Keep reset_at current for an existing pool that has not been touched this period.
    sqlite.prepare("UPDATE ai_token_pools SET reset_at = ? WHERE pool_type = 'shared' AND reset_at < ?")
      .run(resetAt, new Date().toISOString());
  }
  const solExists = findPool.get("sol");
  if (!solExists) {
    insertPool.run(newId("aitp"), "GPT-5.6 Sol 獨立額度池", "sol", 200_000, resetAt, now, now);
  } else {
    sqlite.prepare("UPDATE ai_token_pools SET reset_at = ? WHERE pool_type = 'sol' AND reset_at < ?")
      .run(resetAt, new Date().toISOString());
  }

  const sharedPoolId = (findPool.get("shared") as { id: string }).id;
  const solPoolId = (findPool.get("sol") as { id: string }).id;

  type LogicalSeed = {
    logicalModelId: string;
    providerId: string;
    providerModelName: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    poolId: string;
    dailyLimit: number;
    priority: number;
    fallbackLogicalModelId?: string;
  };
  const seeds: LogicalSeed[] = [
    { logicalModelId: "gpt-5.4-mini", providerId: "openai", providerModelName: "gpt-5.4-mini",
      contextWindowTokens: 128_000, maxOutputTokens: 4096, poolId: sharedPoolId, dailyLimit: 200_000, priority: 100 },
    { logicalModelId: "gpt-5.6-luna", providerId: "openai", providerModelName: "gpt-5.6-luna",
      contextWindowTokens: 128_000, maxOutputTokens: 4096, poolId: sharedPoolId, dailyLimit: 200_000, priority: 110 },
    { logicalModelId: "gpt-5.6-terra", providerId: "openai", providerModelName: "gpt-5.6-terra",
      contextWindowTokens: 128_000, maxOutputTokens: 8192, poolId: sharedPoolId, dailyLimit: 900_000, priority: 90 },
    { logicalModelId: "gpt-5.4-nano", providerId: "openai", providerModelName: "gpt-5.4-nano",
      contextWindowTokens: 128_000, maxOutputTokens: 2048, poolId: sharedPoolId, dailyLimit: 600_000, priority: 80 },
    { logicalModelId: "gpt-5.6-sol", providerId: "openai", providerModelName: "gpt-5.6-sol",
      contextWindowTokens: 200_000, maxOutputTokens: 8192, poolId: solPoolId, dailyLimit: 200_000, priority: 50 }
  ];

  const findLogical = sqlite.prepare("SELECT id FROM ai_logical_models WHERE logical_model_id = ?");
  const insertLogical = sqlite.prepare(`
    INSERT INTO ai_logical_models
      (id, logical_model_id, provider_id, provider_model_name,
       context_window_tokens, max_input_tokens, max_output_tokens,
       supports_thinking, tokenizer_type, tokenizer_version,
       enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 'char-3', '1', 1, ?, ?)
  `);
  const findLimit = sqlite.prepare("SELECT id FROM ai_model_daily_limits WHERE logical_model_id = ?");
  const insertLimit = sqlite.prepare(`
    INSERT INTO ai_model_daily_limits
      (id, logical_model_id, pool_id, daily_limit, used_tokens, reserved_tokens,
       priority, fallback_logical_model_id, enabled, allow_second_model_verification,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?, 1, 1, ?, ?)
  `);

  for (const seed of seeds) {
    if (!findLogical.get(seed.logicalModelId)) {
      insertLogical.run(
        newId("ailm"), seed.logicalModelId, seed.providerId, seed.providerModelName,
        seed.contextWindowTokens, seed.maxOutputTokens, now, now
      );
    }
    if (!findLimit.get(seed.logicalModelId)) {
      insertLimit.run(
        newId("aimdl"), seed.logicalModelId, seed.poolId, seed.dailyLimit,
        seed.priority, seed.fallbackLogicalModelId ?? null, now, now
      );
    }
  }
}

/**
 * Backfill one ai_credential_daily_limits row per OpenAI credential (across ALL
 * provider='openai' configs, not just the default/router config). Defaults to
 * enabled=0 with NULL limits so the upgrade never silently starts deducting a
 * new quota dimension — an admin must opt in. Non-OpenAI credentials are never
 * touched. Existing encrypted keys, fingerprints and statuses are unchanged.
 * Historical usage is never redistributed. Idempotent: re-running is a no-op.
 */
function backfillOpenAiCredentialDailyLimits(sqlite: Database.Database): void {
  const resetAt = migrationDailyReset(new Date());
  const openAiCredentials = sqlite.prepare(
    `SELECT c.id AS credential_id
       FROM ai_provider_credentials c
       JOIN ai_provider_configs cfg ON cfg.id = c.provider_config_id
      WHERE cfg.provider = 'openai'
        AND c.deleted_at IS NULL
        AND cfg.deleted_at IS NULL`
  ).all() as Array<{ credential_id: string }>;
  const findExisting = sqlite.prepare(
    "SELECT id FROM ai_credential_daily_limits WHERE credential_id = ? LIMIT 1"
  );
  const insert = sqlite.prepare(
    `INSERT INTO ai_credential_daily_limits
       (id, credential_id, daily_token_limit, daily_cost_limit_micro_usd,
        timezone, warning_threshold, enabled, reset_at, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'Asia/Taipei', 80, 0, ?, ?, ?)`
  );
  const nowIso = new Date().toISOString();
  for (const row of openAiCredentials) {
    if (findExisting.get(row.credential_id)) continue;
    insert.run(newId("aicdl"), row.credential_id, resetAt, nowIso, nowIso);
  }
}

/** Idempotently create all tables (and backfill new columns) on the connection. */
export function runMigrations(sqlite: Database.Database): void {
  const tx = sqlite.transaction(() => {
    for (const stmt of STATEMENTS) {
      sqlite.exec(stmt);
    }
    // Backfill columns added after the initial schema. Existing rows pick up the
    // DEFAULT, so legacy books become '未分類' without a destructive migration.
    addColumnIfMissing(sqlite, "books", "category", "category TEXT NOT NULL DEFAULT '未分類'");
    addColumnIfMissing(sqlite, "book_files", "role", "role TEXT NOT NULL DEFAULT 'source_document'");
    addColumnIfMissing(sqlite, "book_files", "related_file_id", "related_file_id TEXT");
    addColumnIfMissing(sqlite, "ai_usage_logs", "credential_id", "credential_id TEXT");
    // Credential compliance metadata. Legacy rows are deliberately unknown;
    // migration never infers a Personal or production plan from old fields.
    addColumnIfMissing(sqlite, "ai_provider_credentials", "billing_mode", "billing_mode TEXT NOT NULL DEFAULT 'unknown'");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "region", "region TEXT");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "endpoint_profile", "endpoint_profile TEXT");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "usage_scope", "usage_scope TEXT NOT NULL DEFAULT 'unknown'");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "production_authorized", "production_authorized INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "provider_health", "provider_health TEXT NOT NULL DEFAULT 'unknown'");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "allow_evaluation", "allow_evaluation INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "evaluation_authorized_at", "evaluation_authorized_at TEXT");
    addColumnIfMissing(sqlite, "ai_provider_credentials", "evaluation_authorized_by_admin_id", "evaluation_authorized_by_admin_id TEXT");
    // Provider adapter type and provider instance identity are separate. The
    // table rebuild removes the legacy UNIQUE(provider) constraint while
    // preserving every existing row and its id.
    migrateProviderInstanceIdentity(sqlite);
    addColumnIfMissing(sqlite, "ai_evaluation_settings", "evaluation_pool_id", "evaluation_pool_id TEXT");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "traffic_class", "traffic_class TEXT NOT NULL DEFAULT 'evaluation'");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "max_token_budget", "max_token_budget INTEGER");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "consumed_tokens", "consumed_tokens INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "daily_budget_snapshot", "daily_budget_snapshot INTEGER");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "evaluation_pool_id", "evaluation_pool_id TEXT");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "cancel_requested_at", "cancel_requested_at TEXT");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "cancelled_at", "cancelled_at TEXT");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "preflight_id", "preflight_id TEXT");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "logical_model_ids_json", "logical_model_ids_json TEXT");
    addColumnIfMissing(sqlite, "ai_evaluation_runs", "provider_ids_json", "provider_ids_json TEXT");
    addColumnIfMissing(sqlite, "ai_multi_model_pilot_settings", "readiness_review_json", "readiness_review_json TEXT NOT NULL DEFAULT '{}' ");
    addColumnIfMissing(sqlite, "ai_evaluation_token_pools", "traffic_class", "traffic_class TEXT NOT NULL DEFAULT 'evaluation'");
    addColumnIfMissing(sqlite, "ai_logical_models", "provider_config_id", "provider_config_id TEXT");
  // ----- AI Usage Log Q&A detail + token/cost breakdown (spec §2, §6) -------
  // Idempotent column additions; legacy rows keep NULL text / 0 cost defaults.
  addColumnIfMissing(sqlite, "ai_usage_logs", "question_text", "question_text TEXT");
  addColumnIfMissing(sqlite, "ai_usage_logs", "answer_text", "answer_text TEXT");
  addColumnIfMissing(sqlite, "ai_usage_logs", "cached_input_tokens", "cached_input_tokens INTEGER");
  addColumnIfMissing(sqlite, "ai_usage_logs", "thinking_tokens", "thinking_tokens INTEGER");
  addColumnIfMissing(sqlite, "ai_usage_logs", "input_cost_microusd", "input_cost_microusd INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "ai_usage_logs", "cached_input_cost_microusd", "cached_input_cost_microusd INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "ai_usage_logs", "output_cost_microusd", "output_cost_microusd INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "ai_usage_logs", "total_cost_microusd", "total_cost_microusd INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "ai_usage_logs", "pricing_source", "pricing_source TEXT");
  addColumnIfMissing(sqlite, "ai_usage_logs", "pricing_version", "pricing_version TEXT");
  addColumnIfMissing(sqlite, "ai_usage_logs", "pricing_snapshot_json", "pricing_snapshot_json TEXT");
  addColumnIfMissing(sqlite, "ai_usage_logs", "usage_source", "usage_source TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "last_seen_at", "last_seen_at TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "user_agent", "user_agent TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "os_name", "os_name TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "os_version", "os_version TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "browser_name", "browser_name TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "browser_version", "browser_version TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "device_type", "device_type TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "device_vendor", "device_vendor TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "device_model", "device_model TEXT");
    // Account security: login IP tracking + admin risk/block controls.
    addColumnIfMissing(sqlite, "chat_sessions", "last_ip_address", "last_ip_address TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "last_ip_country", "last_ip_country TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "last_ip_region", "last_ip_region TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "last_ip_city", "last_ip_city TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "last_ip_source", "last_ip_source TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "risk_level", "risk_level TEXT NOT NULL DEFAULT 'safe'");
    addColumnIfMissing(sqlite, "chat_sessions", "is_blocked", "is_blocked INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "chat_sessions", "blocked_at", "blocked_at TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "blocked_reason", "blocked_reason TEXT");
    addColumnIfMissing(sqlite, "chat_sessions", "risk_note", "risk_note TEXT");
    addColumnIfMissing(sqlite, "book_chapters", "level", "level INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "book_chapters", "source", "source TEXT NOT NULL DEFAULT 'manual'");
    addColumnIfMissing(sqlite, "ai_request_logs", "provider_attempts_json", "provider_attempts_json TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(sqlite, "ai_request_logs", "diagnostics_json", "diagnostics_json TEXT");
    // Token-based recovery + retention columns for guest_ask_answers (spec §2, §3).
    addColumnIfMissing(sqlite, "guest_ask_answers", "visitor_ip_hmac", "visitor_ip_hmac TEXT");
    addColumnIfMissing(sqlite, "guest_ask_answers", "recovery_token_digest", "recovery_token_digest TEXT");
    addColumnIfMissing(sqlite, "guest_ask_answers", "expires_at", "expires_at TEXT");
    // Backfill expires_at for pre-existing rows that predate retention. Rows are
    // assigned a 7-day expiry measured from their created_at. The guard
    // (`expires_at IS NULL`) makes this idempotent: a second migration run does
    // not reset or rewrite already-populated expiry values. Rows without a
    // recovery_token_digest remain unrestorable by design (no token = no auth).
    {
      const retentionDays = 7;
      sqlite
        .prepare(
          `UPDATE guest_ask_answers
             SET expires_at = datetime(created_at, ?)
           WHERE expires_at IS NULL`
        )
        .run(`+${retentionDays} days`);
    }
    // Created here (not in STATEMENTS) because it depends on the expires_at
    // column added just above; databases with the previous schema lack it.
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_guest_ask_answers_expires ON guest_ask_answers(expires_at)");
    addColumnIfMissing(sqlite, "ai_daily_usage", "reserved_tokens", "reserved_tokens INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "ai_daily_usage", "reserved_cost_micro_usd", "reserved_cost_micro_usd INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "reset_timezone", "reset_timezone TEXT NOT NULL DEFAULT 'Asia/Taipei'");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "usage_source", "usage_source TEXT NOT NULL DEFAULT 'system_estimated'");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "is_default", "is_default INTEGER NOT NULL DEFAULT 0");
    // ----- DB-backed model pricing config (spec §5.1). Legacy rows get NULL
    // pricing fields, so the seed/fallback table applies until configured. -----
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "currency", "currency TEXT");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "service_tier", "service_tier TEXT");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "input_price_usd_per_million", "input_price_usd_per_million REAL");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "output_price_usd_per_million", "output_price_usd_per_million REAL");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "cached_input_price_usd_per_million", "cached_input_price_usd_per_million REAL");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "cache_storage_usd_per_million_token_hour", "cache_storage_usd_per_million_token_hour REAL");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "pricing_effective_at", "pricing_effective_at TEXT");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "pricing_source", "pricing_source TEXT");
    addColumnIfMissing(sqlite, "ai_credential_model_quotas", "pricing_unavailable", "pricing_unavailable INTEGER NOT NULL DEFAULT 0");
    backfillCredentialDefaultModels(sqlite);
    // One enabled default is the database-level invariant. The backfill above
    // normalises legacy rows before this unique partial index is created.
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credential_model_quotas_default ON ai_credential_model_quotas(credential_id) WHERE is_default = 1 AND enabled = 1");
    // This index must be created after the legacy-column backfill above. Older
    // databases have ai_usage_logs but no credential_id column yet.
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_credential ON ai_usage_logs(credential_id)");
    // ----- Token Pool usage-log provenance (spec §6). Sourced from the
    // composite reservation, never guessed from pricing config. Legacy NULL. ----
    addColumnIfMissing(sqlite, "ai_usage_logs", "pool_id", "pool_id TEXT");
    addColumnIfMissing(sqlite, "ai_usage_logs", "logical_model_id", "logical_model_id TEXT");
    addColumnIfMissing(sqlite, "ai_usage_logs", "estimated", "estimated INTEGER");
    addColumnIfMissing(sqlite, "ai_usage_logs", "overage_tokens", "overage_tokens INTEGER");
    // ----- OpenAI Credential daily ledger: usage-log provenance columns. -----
    addColumnIfMissing(sqlite, "ai_usage_logs", "credential_daily_reservation_key", "credential_daily_reservation_key TEXT");
    addColumnIfMissing(sqlite, "ai_usage_logs", "usage_attempt", "usage_attempt INTEGER");
    addColumnIfMissing(sqlite, "ai_usage_logs", "cost_status", "cost_status TEXT DEFAULT 'unconfigured'");
    // Backfill one daily-limit row per OpenAI credential (idempotent).
    backfillOpenAiCredentialDailyLimits(sqlite);
    // Seed the Token Pool defaults (idempotent). Must run after the tables exist.
    seedLogicalModelsAndPools(sqlite);
  });
  tx();
}

async function main() {
  const dbPath = resolveDbPath();
  const { sqlite } = createDbHandle(dbPath);
  runMigrations(sqlite);
  sqlite.close();
  console.log(`[db] migration complete: ${dbPath}`);
}

// Run when executed directly via `tsx src/migrate.ts`.
const invokedDirectly = process.argv[1]?.includes("migrate");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
