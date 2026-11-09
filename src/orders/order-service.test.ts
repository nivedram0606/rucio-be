import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "../db/client";
import {
  createOrder,
  listOrders,
  OrderManagementError,
  updateKotStatus,
  validateOrderItems,
} from "./order-service";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));

describe("order service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates order items correctly", () => {
    expect(() => validateOrderItems([])).toThrow(OrderManagementError);
    expect(() => validateOrderItems("invalid")).toThrow(OrderManagementError);
    expect(() => validateOrderItems([{ menuItemId: "", quantity: 1 }])).toThrow(OrderManagementError);
    expect(() => validateOrderItems([{ menuItemId: "item-1", quantity: 0 }])).toThrow(OrderManagementError);
    expect(() => validateOrderItems([{ menuItemId: "item-1", quantity: -2 }])).toThrow(OrderManagementError);
    expect(() => validateOrderItems([{ menuItemId: "item-1", quantity: 1.5 }])).toThrow(OrderManagementError);

    const valid = validateOrderItems([
      { menuItemId: "item-1", quantity: 2, instructions: " Extra spicy " },
    ]);
    expect(valid).toEqual([
      { menuItemId: "item-1", quantity: 2, instructions: "Extra spicy" },
    ]);
  });

  it("creates an order, KOT ticket, and audit log atomically with correct totals", async () => {
    const mockMenuItem = {
      id: "item-1",
      restaurantId: "rest-1",
      name: "Truffle Arancini",
      price: 240,
      taxRate: 0.05,
      isAvailable: true,
      deletedAt: null,
    };

    const mockOrder = {
      id: "ord-1",
      restaurantId: "rest-1",
      orderNumber: "ORD-0001",
      type: "DINE_IN",
      status: "SUBMITTED",
      notes: "Table: T1",
      subtotal: 480,
      taxTotal: 24,
      grandTotal: 504,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      items: [
        {
          id: "oi-1",
          menuItemId: "item-1",
          itemName: "Truffle Arancini",
          quantity: 2,
          unitPrice: 240,
          taxRate: 0.05,
          taxAmount: 24,
          total: 480,
          instructions: null,
        },
      ],
    };

    const mockKot = {
      id: "kot-1",
      restaurantId: "rest-1",
      orderId: "ord-1",
      kotNumber: "KOT-0001",
      status: "NEW",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    };

    const tx = {
      order: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => mockOrder),
      },
      kotTicket: {
        create: vi.fn(async () => mockKot),
      },
      auditLog: {
        create: vi.fn(async () => ({})),
      },
    };

    const prisma = {
      menuItem: {
        findMany: vi.fn(async () => [mockMenuItem]),
      },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createOrder({
      restaurantId: "rest-1",
      actorUserId: "user-1",
      tableNumber: "T1",
      items: [{ menuItemId: "item-1", quantity: 2 }],
    });

    expect(result.orderNumber).toBe("ORD-0001");
    expect(result.tableNumber).toBe("T1");
    expect(result.subtotal).toBe(480);
    expect(result.taxTotal).toBe(24);
    expect(result.grandTotal).toBe(504);
    expect(result.kots).toHaveLength(1);
    expect(result.kots[0].kotNumber).toBe("KOT-0001");
    expect(tx.order.create).toHaveBeenCalled();
    expect(tx.kotTicket.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("rejects order creation if a menu item does not belong to the restaurant", async () => {
    const prisma = {
      menuItem: {
        findMany: vi.fn(async () => []), // none found for this restaurant
      },
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(
      createOrder({
        restaurantId: "rest-1",
        actorUserId: "user-1",
        items: [{ menuItemId: "foreign-item", quantity: 1 }],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("updates KOT status and records audit log", async () => {
    const mockKot = {
      id: "kot-1",
      restaurantId: "rest-1",
      kotNumber: "KOT-0001",
      status: "NEW",
    };

    const updatedKot = {
      ...mockKot,
      status: "PREPARING",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    };

    const tx = {
      kotTicket: {
        update: vi.fn(async () => updatedKot),
      },
      auditLog: {
        create: vi.fn(async () => ({})),
      },
    };

    const prisma = {
      kotTicket: {
        findFirst: vi.fn(async () => mockKot),
      },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await updateKotStatus({
      restaurantId: "rest-1",
      actorUserId: "user-1",
      kotId: "kot-1",
      status: "PREPARING",
    });

    expect(result.status).toBe("PREPARING");
    expect(tx.kotTicket.update).toHaveBeenCalledWith({
      where: { id: "kot-1" },
      data: { status: "PREPARING" },
    });
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("rejects invalid KOT status transitions or missing KOT tickets", async () => {
    await expect(
      updateKotStatus({
        restaurantId: "rest-1",
        actorUserId: "user-1",
        kotId: "kot-1",
        status: "INVALID_STATUS",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const prisma = {
      kotTicket: {
        findFirst: vi.fn(async () => null),
      },
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(
      updateKotStatus({
        restaurantId: "rest-1",
        actorUserId: "user-1",
        kotId: "nonexistent",
        status: "READY",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists orders for a restaurant", async () => {
    const prisma = {
      order: {
        findMany: vi.fn(async () => [
          {
            id: "ord-1",
            orderNumber: "ORD-0001",
            type: "DINE_IN",
            status: "SUBMITTED",
            notes: "Table: 4",
            subtotal: 200,
            taxTotal: 10,
            grandTotal: 210,
            createdAt: new Date("2026-11-01T00:00:00Z"),
            items: [],
            kots: [],
          },
        ]),
      },
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const list = await listOrders("rest-1");
    expect(list).toHaveLength(1);
    expect(list[0].orderNumber).toBe("ORD-0001");
    expect(list[0].tableNumber).toBe("4");
    expect(list[0].grandTotal).toBe(210);
  });
});
