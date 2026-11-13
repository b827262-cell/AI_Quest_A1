// Security test fixtures - secret redaction test samples.
// All values are obviously fake placeholders. No real secrets.

export const SECRET_REDACTION_SAMPLES = [
  {
    name: "stripe_fake_key",
    input: "The key is stripe_fake_test_key_not_real_1234567890",
    expected: "[REDACTED]"
  },
  {
    name: "aws_access_key",
    input: "AKIAIOSFODNN7EXAMPLEKEY",
    expected: "[REDACTED]"
  },
  {
    name: "github_token",
    input: "ghp_1234567890abcdef1234567890abcdef12345678",
    expected: "[REDACTED]"
  },
  {
    name: "private_key",
    input: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
    expected: "[REDACTED]"
  },
  {
    name: "admin_password",
    input: "ADMIN_PASSWORD=super-secret-password-123",
    expected: "[REDACTED]"
  },
  {
    name: "normal_text",
    input: "The course starts on Monday at 9 AM.",
    expected: "The course starts on Monday at 9 AM."
  }
];

export const REDACT_PATTERNS = [
  /sk_[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /ADMIN_PASSWORD\s*=\s*\S+/i
];

export function redactSecrets(input) {
  let output = input;
  for (const pattern of REDACT_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function hasUnredactedSecret(input) {
  return REDACT_PATTERNS.some((p) => p.test(input));
}
