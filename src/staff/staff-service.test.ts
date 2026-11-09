import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "../db/client";
import {
  createRestaurantStaff,
  listRestaurantStaff,
  normalizeStaffEmail,
  normalizeStaffName,
  normalizeStaffPhone,
  StaffManagementError,
} from "./staff-service";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));
vi.mock("../auth/password", () => ({ hashPassword: vi.fn(async () => "scrypt$mocked$hash") }));

describe("staff service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes and validates staff attributes", () => {
    expect(normalizeStaffName("  Chef   Marcus ")).toBe("Chef Marcus");
    expect(normalizeStaffEmail(" CHEF@example.com ")).toBe("chef@example.com");
    expect(normalizeStaffPhone(" +1 555 987 6543 ")).toBe("+1 555 987 6543");
    expect(normalizeStaffPhone(undefined)).toBeNull();

    expect(() => normalizeStaffName("")).toThrow(StaffManagementError);
    expect(() => normalizeStaffEmail("invalid-email")).toThrow(StaffManagementError);
  });

  it("creates a staff member and assigns role atomically in one transaction", async () => {
    const role = { id: "role-waiter-1", name: "Waiter", restaurantId: "rest-1" };
    const user = {
      id: "user-new-1",
      name: "Marcus Thorne",
      email: "marcus.t@restaurant.test",
      phone: "+15559876543",
      status: "ACTIVE",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    };

    const tx = {
      user: { create: vi.fn(async () => user) },
      userRole: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
    };

    const prisma = {
      role: { findFirst: vi.fn(async () => role) },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createRestaurantStaff({
      restaurantId: "rest-1",
      actorUserId: "admin-1",
      name: "Marcus Thorne",
      email: "marcus.t@restaurant.test",
      role: "Waiter",
      phone: "+15559876543",
    });

    expect(result).toMatchObject({
      id: "user-new-1",
      name: "Marcus Thorne",
      email: "marcus.t@restaurant.test",
      role: "Waiter",
      status: "ACTIVE",
    });
    expect(tx.user.create).toHaveBeenCalled();
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { restaurantId: "rest-1", userId: "user-new-1", roleId: "role-waiter-1" },
    });
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("rejects staff creation when role does not exist in the tenant", async () => {
    const prisma = {
      role: { findFirst: vi.fn(async () => null) },
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(
      createRestaurantStaff({
        restaurantId: "rest-1",
        actorUserId: "admin-1",
        name: "Marcus Thorne",
        email: "marcus.t@restaurant.test",
        role: "NonExistentRole",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps duplicate email conflict to a safe error", async () => {
    const role = { id: "role-waiter-1", name: "Waiter", restaurantId: "rest-1" };
    const tx = {
      user: { create: vi.fn(async () => { throw { code: "P2002" }; }) },
    };
    const prisma = {
      role: { findFirst: vi.fn(async () => role) },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(
      createRestaurantStaff({
        restaurantId: "rest-1",
        actorUserId: "admin-1",
        name: "Marcus Thorne",
        email: "marcus.t@restaurant.test",
        role: "Waiter",
      })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "A team member with that email address already exists." });
  });

  it("lists staff members scoped to the tenant with their role names", async () => {
    const users = [
      {
        id: "user-1",
        name: "Admin User",
        email: "admin@test.com",
        phone: null,
        status: "ACTIVE",
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        userRoles: [{ role: { name: "Admin" } }],
      },
    ];

    const prisma = { user: { findMany: vi.fn(async () => users) } };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await listRestaurantStaff("rest-1");
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("Admin");
  });
});
