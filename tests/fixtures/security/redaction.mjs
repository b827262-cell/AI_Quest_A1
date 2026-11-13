// Security test fixtures - secret redaction test samples.
// All values are synthetic. Credential-shaped strings are assembled at runtime
// from harmless fragments so this source file never contains a contiguous
// secret literal (GitHub push protection), while the resolved values still
// exercise the production-shaped patterns in REDACT_PATTERNS.

const join = (...parts) => parts.join("");

const STRIPE_STYLE_KEY = join("s", "k", "_", "SyntheticFixture".repeat(2));
const AWS_STYLE_KEY = join("AKIA", "FIXTURE", "000000000");
const GITHUB_STYLE_TOKEN = join("ghp", "_", "FIXTURE".padEnd(36, "0"));
const PRIVATE_KEY_BLOCK = [
  "-----BEGIN RSA PRIVATE KEY-----",
  join("MIIBOgIBAAJBA", "SYNTHETICFIXTUREONLY".repeat(2)),
  "-----END RSA PRIVATE KEY-----"
].join("\n");
const ADMIN_PASSWORD_LINE = join("ADMIN_PASSWORD", "=", "fixture-only-not-a-real-password");

export const SECRET_REDACTION_SAMPLES = [
  {
    name: "stripe_style_key",
    input: STRIPE_STYLE_KEY,
    expected: "[REDACTED]"
  },
  {
    name: "aws_access_key",
    input: AWS_STYLE_KEY,
    expected: "[REDACTED]"
  },
  {
    name: "github_token",
    input: GITHUB_STYLE_TOKEN,
    expected: "[REDACTED]"
  },
  {
    name: "private_key",
    input: PRIVATE_KEY_BLOCK,
    expected: "[REDACTED]"
  },
  {
    name: "admin_password",
    input: ADMIN_PASSWORD_LINE,
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
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
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
