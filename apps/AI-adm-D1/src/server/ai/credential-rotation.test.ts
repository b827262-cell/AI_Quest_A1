import { afterEach, describe, expect, it } from "vitest";
import { createDbHandle, runMigrations } from "@ai-smartbook/db";
import {
  decryptCredentialWithKey,
  encryptCredentialWithKey
} from "./credential-crypto";
import { rotateCredentialKeys, verifyCredentialKeys } from "./credential-rotation";

const oldKey = "old-master-key-for-unit-tests-0123456789";
const newKey = "new-master-key-for-unit-tests-9876543210";
let handle: ReturnType<typeof createDbHandle> | undefined;

function setup() {
  handle = createDbHandle(":memory:");
  runMigrations(handle.sqlite);
  const insert = handle.sqlite.prepare(`
    INSERT INTO ai_provider_credentials
      (id, provider_config_id, name, encrypted_api_key, masked_api_key, key_fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  insert.run("credential-one", "provider-one", "one", encryptCredentialWithKey("credential-one-value", oldKey), "cre****alue", "fingerprint-one", now, now);
  insert.run("credential-two", "provider-one", "two", encryptCredentialWithKey("credential-two-value", oldKey), "cre****alue", "fingerprint-two", now, now);
  return handle.sqlite;
}

afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

describe("credential master-key rotation", () => {
  it("supports dry-run and atomically rotates to a fresh AES-GCM envelope", () => {
    const db = setup();
    const before = db.prepare("SELECT encrypted_api_key FROM ai_provider_credentials ORDER BY id").all() as Array<{ encrypted_api_key: string }>;
    const dryRun = rotateCredentialKeys(db, { oldKey, newKey, dryRun: true });
    expect(dryRun).toMatchObject({ planned: 2, rotated: 0, dryRun: true });
    expect(db.prepare("SELECT encrypted_api_key FROM ai_provider_credentials ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM ai_admin_audit_logs").get()).toEqual({ count: 0 });

    const result = rotateCredentialKeys(db, { oldKey, newKey, dryRun: false });
    expect(result).toMatchObject({ planned: 2, rotated: 2, dryRun: false });
    const rows = db.prepare("SELECT id, encrypted_api_key FROM ai_provider_credentials ORDER BY id").all() as Array<{ id: string; encrypted_api_key: string }>;
    expect(rows[0].encrypted_api_key).not.toBe(before[0].encrypted_api_key);
    expect(decryptCredentialWithKey(rows[0].encrypted_api_key, newKey)).toBe("credential-one-value");
    expect(() => decryptCredentialWithKey(rows[0].encrypted_api_key, oldKey)).toThrow();
    expect(verifyCredentialKeys(db, newKey)).toBe(2);
    const audit = db.prepare("SELECT action, metadata_json FROM ai_admin_audit_logs").get() as { action: string; metadata_json: string };
    expect(audit.action).toBe("credential.master_key_rotated");
    expect(audit.metadata_json).not.toContain("credential-one-value");
    expect(audit.metadata_json).not.toContain("encrypted_api_key");
  });

  it("rejects a wrong old key or invalid new key without modifying rows", () => {
    const db = setup();
    const before = db.prepare("SELECT encrypted_api_key FROM ai_provider_credentials ORDER BY id").all();
    expect(() => rotateCredentialKeys(db, { oldKey: "wrong-master-key-for-unit-tests-0123456789", newKey, dryRun: false })).toThrow("old master key");
    expect(() => rotateCredentialKeys(db, { oldKey, newKey: "too-short", dryRun: false })).toThrow("master key");
    expect(db.prepare("SELECT encrypted_api_key FROM ai_provider_credentials ORDER BY id").all()).toEqual(before);
  });

  it("rolls back all updates if SQLite rejects one row", () => {
    const db = setup();
    db.exec("CREATE TRIGGER reject_second BEFORE UPDATE OF encrypted_api_key ON ai_provider_credentials WHEN OLD.id = 'credential-two' BEGIN SELECT RAISE(ABORT, 'maintenance test failure'); END");
    const before = db.prepare("SELECT id, encrypted_api_key FROM ai_provider_credentials ORDER BY id").all() as Array<{ id: string; encrypted_api_key: string }>;
    expect(() => rotateCredentialKeys(db, { oldKey, newKey, dryRun: false })).toThrow();
    const after = db.prepare("SELECT id, encrypted_api_key FROM ai_provider_credentials ORDER BY id").all();
    expect(after).toEqual(before);
    expect(verifyCredentialKeys(db, oldKey)).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM ai_admin_audit_logs").get()).toEqual({ count: 0 });
  });
});
