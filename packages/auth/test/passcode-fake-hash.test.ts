import { expect, it, vi } from "vitest";
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, scrypt: vi.fn(original.scrypt), timingSafeEqual: vi.fn(original.timingSafeEqual) };
});
it("runs scrypt even for an unknown email", async () => {
  const crypto = await import("node:crypto");
  const { verifyStudentPasscode } = await import("../src/passcode");
  expect(await verifyStudentPasscode("incorrect")).toBe(false);
  expect(vi.mocked(crypto.scrypt)).toHaveBeenCalledOnce();
});

it("uses timingSafeEqual and the required scrypt cost parameters", async () => {
  const crypto = await import("node:crypto");
  const { hashStudentPasscode, verifyStudentPasscode } = await import("../src/passcode");
  const hash = hashStudentPasscode("ABCDE-FGHJK");
  expect(await verifyStudentPasscode("ABCDE-FGHJK", hash)).toBe(true);
  expect(vi.mocked(crypto.timingSafeEqual)).toHaveBeenCalled();
  expect(vi.mocked(crypto.scrypt)).toHaveBeenLastCalledWith("ABCDE-FGHJK", expect.any(Buffer), 32,
    expect.objectContaining({ N: 16384, r: 8, p: 1 }), expect.any(Function));
});
