import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function configuredKey(): string {
  const secret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) throw new Error("AI credential encryption is not configured");
  return secret;
}

/** AES-256-GCM envelope. The master secret itself is never persisted/logged. */
export function encryptCredentialWithKey(value: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function encryptCredential(value: string): string {
  return encryptCredentialWithKey(value, configuredKey());
}

export function decryptCredentialWithKey(envelope: string, masterKey: string): string {
  const [version, ivText, tagText, dataText] = envelope.split(".");
  if (version !== VERSION || !ivText || !tagText || !dataText) throw new Error("invalid credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key(masterKey), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

export function decryptCredential(envelope: string): string {
  return decryptCredentialWithKey(envelope, configuredKey());
}

/** Rotation accepts only deployment-grade, printable master-key material. */
export function validateMasterKey(masterKey: string): void {
  if (masterKey.length < 32 || masterKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(masterKey)) {
    throw new Error("master key must be 32-4096 printable characters");
  }
}

export function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function maskCredential(value: string): string {
  const compact = value.trim();
  if (compact.length <= 4) return "****";
  const prefix = compact.slice(0, Math.min(3, compact.length - 4));
  return `${prefix}****${compact.slice(-4)}`;
}

export function assertCredentialEncryptionConfigured(): void {
  const configured = process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY must be configured in production");
  }
}
