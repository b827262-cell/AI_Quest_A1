import { randomUUID } from "node:crypto";
import type { DbHandle } from "@ai-smartbook/db";
import {
  decryptCredentialWithKey,
  encryptCredentialWithKey,
  validateMasterKey
} from "./credential-crypto";

type Sqlite = DbHandle["sqlite"];

export type CredentialRotationResult = {
  planned: number;
  rotated: number;
  skipped: number;
  dryRun: boolean;
};

type CredentialCipherRow = {
  id: string;
  encrypted_api_key: string;
};

/**
 * Re-encrypt every stored credential in one SQLite transaction. Plaintext is
 * held only in this process while the old envelope is authenticated and the
 * new envelope is verified; it is never returned or written to a log.
 */
export function rotateCredentialKeys(
  sqlite: Sqlite,
  options: { oldKey: string; newKey: string; dryRun: boolean }
): CredentialRotationResult {
  validateMasterKey(options.oldKey);
  validateMasterKey(options.newKey);
  if (options.oldKey === options.newKey) throw new Error("old and new master keys must differ");

  const rows = sqlite.prepare(
    "SELECT id, encrypted_api_key FROM ai_provider_credentials ORDER BY id"
  ).all() as CredentialCipherRow[];

  const replacements = rows.map((row) => {
    let plaintext: string;
    try {
      plaintext = decryptCredentialWithKey(row.encrypted_api_key, options.oldKey);
    } catch {
      throw new Error("old master key could not decrypt every credential");
    }
    const encrypted = encryptCredentialWithKey(plaintext, options.newKey);
    try {
      if (decryptCredentialWithKey(encrypted, options.newKey) !== plaintext) {
        throw new Error("verification mismatch");
      }
    } catch {
      throw new Error("new master key verification failed");
    }
    return { id: row.id, encrypted };
  });

  if (options.dryRun) {
    return { planned: rows.length, rotated: 0, skipped: 0, dryRun: true };
  }

  const now = new Date().toISOString();
  const update = sqlite.prepare(
    "UPDATE ai_provider_credentials SET encrypted_api_key = ?, updated_at = ? WHERE id = ?"
  );
  const audit = sqlite.prepare(
    "INSERT INTO ai_admin_audit_logs (id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const transaction = sqlite.transaction(() => {
    for (const replacement of replacements) {
      update.run(replacement.encrypted, now, replacement.id);
    }
    audit.run(
      `maintenance_rotation_${randomUUID()}`,
      "credential.master_key_rotated",
      "credential_vault",
      null,
      JSON.stringify({ credentialCount: replacements.length, dryRun: false }),
      now
    );
  });
  transaction();
  return { planned: rows.length, rotated: replacements.length, skipped: 0, dryRun: false };
}

export function verifyCredentialKeys(sqlite: Sqlite, masterKey: string): number {
  validateMasterKey(masterKey);
  const rows = sqlite.prepare(
    "SELECT encrypted_api_key FROM ai_provider_credentials ORDER BY id"
  ).all() as Array<{ encrypted_api_key: string }>;
  for (const row of rows) {
    try {
      decryptCredentialWithKey(row.encrypted_api_key, masterKey);
    } catch {
      throw new Error("master key could not decrypt every credential");
    }
  }
  return rows.length;
}
