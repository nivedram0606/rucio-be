import { describe, expect, it } from "vitest";
import { hashPassword, PasswordPolicyError, verifyPassword } from "./password";

describe("password utilities", () => {
  it("hashes passwords with a unique salt and verifies the original value", async () => {
    const firstHash = await hashPassword("correct-horse-battery-staple");
    const secondHash = await hashPassword("correct-horse-battery-staple");

    expect(firstHash).not.toBe(secondHash);
    await expect(verifyPassword("correct-horse-battery-staple", firstHash)).resolves.toBe(true);
    await expect(verifyPassword("not-the-password", firstHash)).resolves.toBe(false);
  });

  it("rejects weak passwords with a typed policy error", async () => {
    await expect(hashPassword("short")).rejects.toBeInstanceOf(PasswordPolicyError);
  });

  it("returns false for malformed stored hashes", async () => {
    await expect(verifyPassword("any-password", "not-a-scrypt-hash")).resolves.toBe(false);
    await expect(verifyPassword("any-password", 123 as unknown as string)).resolves.toBe(false);
  });
});
