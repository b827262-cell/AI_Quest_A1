import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src";

describe("secret redaction", () => {
  it("redacts provider keys, authorization values, and bounds log text", () => {
    const raw = JSON.stringify({
      question: "what is safe logging?",
      key: "sk-abcdefghijklmnopqrstuvwxyz123456",
      google: "AIzaabcdefghijklmnopqrstuvwxyz1234567890",
      opaqueProviderKey: "AQ.abcdefghijklmnopqrstuvwxyz123456",
      authorization: "Bearer very-secret-token-value"
    });
    const redacted = redactSensitiveText(raw, 120);
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("AIzaabcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("AQ.abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("very-secret-token-value");
    expect(redacted.length).toBeLessThanOrEqual(120);
  });
});
