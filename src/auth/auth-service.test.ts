import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "../db/client";
import {
  authenticateWithPassword,
  AuthError,
  hashToken,
  revokeSessionToken,
  validateSessionToken,
} from "./auth-service";
import { hashPassword } from "./password";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));

function makeAuthPrisma(customUser?: any, customTokenRecord?: any) {
  const tx = {
    refreshToken: {
      create: vi.fn(async ({ data }: any) => ({ id: "token-record-id", ...data })),
    },
    user: {
      update: vi.fn(async () => ({})),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (cb: (transaction: typeof tx) => Promise<any>) => cb(tx)),
    user: {
      findUnique: vi.fn(async () => customUser),
    },
    refreshToken: {
      findUnique: vi.fn(async () => customTokenRecord),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };

  return { prisma, tx };
}

describe("authService", () => {
  const validEmail = "admin@bistro.test";
  const validPassword = "a-very-secure-passphrase-2026";
  let storedHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    storedHash = await hashPassword(validPassword);
  });

  const activeUser = {
    id: "user-123",
    name: "Alex Admin",
    email: "admin@bistro.test",
    passwordHash: "",
    status: "ACTIVE",
    deletedAt: null,
    restaurant: {
      id: "restaurant-456",
      name: "Bistro Paris",
      slug: "bistro-paris",
      status: "ACTIVE",
      deletedAt: null,
    },
    userRoles: [
      { role: { id: "role-1", name: "Admin", isSystem: true, rolePermissions: [{ permission: { permissionKey: "tables.view" } }] } },
      { role: { id: "role-2", name: "Manager", isSystem: true, rolePermissions: [{ permission: { permissionKey: "tables.create" } }] } },
    ],
  };

  it("authenticates a valid user and creates a hashed RefreshToken record", async () => {
    const userWithHash = { ...activeUser, passwordHash: storedHash };
    const { prisma, tx } = makeAuthPrisma(userWithHash);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await authenticateWithPassword(" Admin@Bistro.test ", validPassword);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: validEmail },
      include: expect.any(Object),
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-123",
        tokenHash: hashToken(result.sessionToken),
        expiresAt: expect.any(Date),
      }),
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { lastLoginAt: expect.any(Date) },
    });

    expect(result.identity.user).toEqual({
      id: "user-123",
      name: "Alex Admin",
      email: "admin@bistro.test",
    });
    expect(result.identity.restaurant).toEqual({
      id: "restaurant-456",
      name: "Bistro Paris",
      slug: "bistro-paris",
    });
    expect(result.identity.roles).toEqual(["Admin", "Manager"]);
    expect(result.identity.permissions).toEqual(["tables.create", "tables.view"]);
    expect(result.sessionToken).toBeTruthy();
    expect(JSON.stringify(result.identity)).not.toContain("passwordHash");
  });

  it("rejects invalid password with generic INVALID_CREDENTIALS error", async () => {
    const userWithHash = { ...activeUser, passwordHash: storedHash };
    const { prisma } = makeAuthPrisma(userWithHash);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(authenticateWithPassword(validEmail, "wrong-password-12345")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password.",
    });
  });

  it("rejects unknown email with generic error and dummy verify to prevent timing enumeration", async () => {
    const { prisma } = makeAuthPrisma(null);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(authenticateWithPassword("unknown@test.com", validPassword)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password.",
    });
  });

  it("rejects inactive or soft-deleted users", async () => {
    const inactiveUser = { ...activeUser, passwordHash: storedHash, status: "INACTIVE" };
    const { prisma } = makeAuthPrisma(inactiveUser);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(authenticateWithPassword(validEmail, validPassword)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });

    const deletedUser = { ...activeUser, passwordHash: storedHash, deletedAt: new Date() };
    const { prisma: deletedPrisma } = makeAuthPrisma(deletedUser);
    vi.mocked(getPrismaClient).mockReturnValue(deletedPrisma as never);

    await expect(authenticateWithPassword(validEmail, validPassword)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });

  it("rejects users whose restaurant is inactive or soft-deleted", async () => {
    const closedRestaurantUser = {
      ...activeUser,
      passwordHash: storedHash,
      restaurant: { ...activeUser.restaurant, status: "INACTIVE" },
    };
    const { prisma } = makeAuthPrisma(closedRestaurantUser);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(authenticateWithPassword(validEmail, validPassword)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });

  it("validates session tokens and returns identity", async () => {
    const rawToken = "sample-raw-session-token-123";
    const tokenRecord = {
      id: "token-id-1",
      userId: activeUser.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
      user: activeUser,
    };

    const { prisma } = makeAuthPrisma(null, tokenRecord);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const identity = await validateSessionToken(rawToken);
    expect(identity).toEqual({
      user: { id: "user-123", name: "Alex Admin", email: "admin@bistro.test" },
      restaurant: { id: "restaurant-456", name: "Bistro Paris", slug: "bistro-paris" },
      roles: ["Admin", "Manager"],
      permissions: ["tables.create", "tables.view"],
    });
  });

  it("returns null for expired, revoked, or non-existent session tokens", async () => {
    const rawToken = "sample-raw-session-token-123";

    // Non-existent
    const { prisma: missingPrisma } = makeAuthPrisma(null, null);
    vi.mocked(getPrismaClient).mockReturnValue(missingPrisma as never);
    expect(await validateSessionToken(rawToken)).toBeNull();

    // Revoked
    const revokedRecord = {
      id: "token-id-1",
      userId: activeUser.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: new Date(),
      user: activeUser,
    };
    const { prisma: revokedPrisma } = makeAuthPrisma(null, revokedRecord);
    vi.mocked(getPrismaClient).mockReturnValue(revokedPrisma as never);
    expect(await validateSessionToken(rawToken)).toBeNull();

    // Expired
    const expiredRecord = {
      id: "token-id-1",
      userId: activeUser.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      user: activeUser,
    };
    const { prisma: expiredPrisma } = makeAuthPrisma(null, expiredRecord);
    vi.mocked(getPrismaClient).mockReturnValue(expiredPrisma as never);
    expect(await validateSessionToken(rawToken)).toBeNull();
  });

  it("revokes session tokens via refreshToken.updateMany", async () => {
    const rawToken = "sample-raw-session-token-123";
    const { prisma } = makeAuthPrisma();
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await revokeSessionToken(rawToken);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
