import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_KEYS, DEFAULT_ROLES } from "../../prisma/seed-permissions";
import { getPrismaClient } from "../db/client";
import { createRestaurantWithAdmin } from "./create-restaurant";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));

function makePrisma(permissionKeys = ALL_KEYS) {
  const tx = {
    permission: {
      findMany: vi.fn(async () => permissionKeys.map((permissionKey, index) => ({ id: `permission-${index}`, permissionKey }))),
    },
    restaurant: {
      create: vi.fn(async ({ data }: { data: { name: string; slug: string } }) => ({
        id: "restaurant-id",
        name: data.name,
        slug: data.slug,
      })),
    },
    role: {
      createMany: vi.fn(async () => ({ count: Object.keys(DEFAULT_ROLES).length })),
      findMany: vi.fn(async () => Object.keys(DEFAULT_ROLES).map((name) => ({ id: `role-${name}`, name }))),
    },
    rolePermission: { createMany: vi.fn(async () => ({ count: 1 })) },
    user: {
      create: vi.fn(async ({ data }: { data: { name: string; email: string; passwordHash: string } }) => ({
        id: "admin-id",
        name: data.name,
        email: data.email,
      })),
    },
    userRole: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { prisma, tx };
}

const validInput = {
  restaurantName: "Sample Restaurant",
  restaurantSlug: "sample-restaurant",
  ownerName: "Alex Owner",
  ownerEmail: "Alex@Example.com",
  ownerPassword: "long-enough-password-123",
};

describe("createRestaurantWithAdmin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates restaurant settings, system roles, grants, the first Admin, and audit record atomically", async () => {
    const { prisma, tx } = makePrisma();
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createRestaurantWithAdmin(validInput);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.permission.findMany).toHaveBeenCalledOnce();
    expect(tx.restaurant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: "Sample Restaurant", slug: "sample-restaurant", settings: { create: {} } }),
    }));
    expect(tx.role.createMany).toHaveBeenCalledWith({
      data: Object.keys(DEFAULT_ROLES).map((name) => ({ restaurantId: "restaurant-id", name, isSystem: true })),
    });
    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ restaurantId: "restaurant-id", email: "alex@example.com" }),
    }));
    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ passwordHash: expect.stringMatching(/^scrypt\$/) }),
    }));
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { userId: "admin-id", roleId: "role-Admin", restaurantId: "restaurant-id" },
    });
    expect(tx.rolePermission.createMany).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result.admin.email).toBe("alex@example.com");
    expect(result.roles).toContain("Admin");
    expect(result).not.toHaveProperty("passwordHash");
  });

  it("fails clearly when the global permission catalog has not been seeded", async () => {
    const { prisma, tx } = makePrisma([]);
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(createRestaurantWithAdmin(validInput)).rejects.toMatchObject({
      code: "CONFIGURATION",
      message: expect.stringContaining("npm run db:seed"),
    });
    expect(tx.restaurant.create).not.toHaveBeenCalled();
  });

  it("maps unique database conflicts to a domain conflict", async () => {
    const { prisma, tx } = makePrisma();
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);
    tx.restaurant.create.mockRejectedValueOnce(Object.assign(new Error("unique constraint"), { code: "P2002" }));

    await expect(createRestaurantWithAdmin(validInput)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("returns domain validation errors for malformed values before accessing the database", async () => {
    await expect(createRestaurantWithAdmin(null as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(createRestaurantWithAdmin({ ...validInput, ownerName: 42 } as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(createRestaurantWithAdmin({ ...validInput, ownerPassword: "short" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(getPrismaClient).not.toHaveBeenCalled();
  });
});
