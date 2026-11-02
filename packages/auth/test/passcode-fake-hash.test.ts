import { expect, it, vi } from "vitest";
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, scrypt: vi.fn(original.scrypt) };
});
it("runs scrypt even for an unknown email", async () => {
  const crypto = await import("node:crypto");
  const { verifyStudentPasscode } = await import("../src/passcode");
  expect(await verifyStudentPasscode("incorrect")).toBe(false);
  expect(vi.mocked(crypto.scrypt)).toHaveBeenCalledOnce();
});
