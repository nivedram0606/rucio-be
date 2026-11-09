import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "../db/client";
import {
  createRestaurantTable,
  listRestaurantTables,
  normalizeTableNumber,
  TableManagementError,
  updateRestaurantTableStatus,
  validateTableCapacity,
} from "./table-service";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));

describe("table service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes identifiers and validates capacity", () => {
    expect(normalizeTableNumber("  p 1 ")).toBe("P 1");
    expect(validateTableCapacity(undefined)).toBe(4);
    expect(validateTableCapacity(50)).toBe(50);
    expect(() => normalizeTableNumber("#1")).toThrow(TableManagementError);
    expect(() => validateTableCapacity(0)).toThrow(TableManagementError);
    expect(() => validateTableCapacity(2.5)).toThrow(TableManagementError);
  });

  it("creates a tenant-scoped table and audit event in one transaction", async () => {
    const table = {
      id: "554f8984-2182-48f6-a33a-88d32713c2e1",
      tableNumber: "P 1",
      capacity: 6,
      status: "AVAILABLE",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    };
    const tx = {
      restaurantTable: { create: vi.fn(async () => table) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createRestaurantTable({
      restaurantId: "restaurant-1",
      actorUserId: "user-1",
      tableNumber: " p 1 ",
      capacity: 6,
    });

    expect(result).toMatchObject({ id: table.id, tableNumber: "P 1", capacity: 6, status: "AVAILABLE" });
    expect(tx.restaurantTable.create).toHaveBeenCalledWith({
      data: { restaurantId: "restaurant-1", tableNumber: "P 1", capacity: 6 },
      select: { id: true, tableNumber: true, capacity: true, status: true, createdAt: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        restaurantId: "restaurant-1",
        userId: "user-1",
        action: "TABLE_CREATED",
        entity: "RestaurantTable",
        entityId: table.id,
        metadata: { tableNumber: "P 1", capacity: 6 },
      },
    });
  });

  it("maps a tenant-unique conflict to a safe error", async () => {
    const tx = { restaurantTable: { create: vi.fn(async () => { throw { code: "P2002" }; }) }, auditLog: { create: vi.fn() } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);
    await expect(createRestaurantTable({ restaurantId: "restaurant-1", actorUserId: "user-1", tableNumber: "T1" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "A table with that number already exists." });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("lists only non-deleted tables for the supplied restaurant", async () => {
    const table = { id: "table-1", tableNumber: "T1", capacity: 4, status: "AVAILABLE", createdAt: new Date("2026-11-01T00:00:00.000Z") };
    const prisma = { restaurantTable: { findMany: vi.fn(async () => [table]) } };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);
    await expect(listRestaurantTables("restaurant-1")).resolves.toMatchObject([{ tableNumber: "T1" }]);
    expect(prisma.restaurantTable.findMany).toHaveBeenCalledWith({
      where: { restaurantId: "restaurant-1", deletedAt: null },
      orderBy: [{ tableNumber: "asc" }, { id: "asc" }],
      select: { id: true, tableNumber: true, capacity: true, status: true, createdAt: true },
    });
  });

  it("updates table status with validation and audit logging", async () => {
    const existingTable = {
      id: "table-1",
      tableNumber: "T1",
      capacity: 4,
      status: "AVAILABLE",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    };
    const updatedTable = { ...existingTable, status: "OCCUPIED" };
    const tx = {
      restaurantTable: { update: vi.fn(async () => updatedTable) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      restaurantTable: { findFirst: vi.fn(async () => existingTable) },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await updateRestaurantTableStatus({
      restaurantId: "restaurant-1",
      actorUserId: "user-1",
      tableId: "table-1",
      status: "OCCUPIED",
    });

    expect(result.status).toBe("OCCUPIED");
    expect(tx.restaurantTable.update).toHaveBeenCalledWith({
      where: { id: "table-1" },
      data: { status: "OCCUPIED" },
      select: { id: true, tableNumber: true, capacity: true, status: true, createdAt: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        restaurantId: "restaurant-1",
        userId: "user-1",
        action: "TABLE_STATUS_UPDATED",
        entity: "RestaurantTable",
        entityId: "table-1",
        metadata: {
          tableNumber: "T1",
          oldStatus: "AVAILABLE",
          newStatus: "OCCUPIED",
        },
      },
    });
  });

  it("rejects invalid status or missing table", async () => {
    await expect(
      updateRestaurantTableStatus({
        restaurantId: "restaurant-1",
        actorUserId: "user-1",
        tableId: "table-1",
        status: "INVALID_STATUS",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const prisma = { restaurantTable: { findFirst: vi.fn(async () => null) } };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(
      updateRestaurantTableStatus({
        restaurantId: "restaurant-1",
        actorUserId: "user-1",
        tableId: "table-999",
        status: "OCCUPIED",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

