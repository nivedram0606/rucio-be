import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "../db/client";
import {
  createCustomer,
  listCustomers,
  normalizeCustomerEmail,
  normalizeCustomerName,
  normalizeCustomerPhone,
  CustomerManagementError,
} from "./customer-service";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));

describe("customer service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes and validates customer attributes", () => {
    expect(normalizeCustomerName("  Jane   Doe ")).toBe("Jane Doe");
    expect(normalizeCustomerPhone(" +1 555 123 4567 ")).toBe("+1 555 123 4567");
    expect(normalizeCustomerPhone(undefined)).toBeNull();
    expect(normalizeCustomerEmail(" JANE@example.com ")).toBe("jane@example.com");
    expect(normalizeCustomerEmail("")).toBeNull();

    expect(() => normalizeCustomerName("")).toThrow(CustomerManagementError);
    expect(() => normalizeCustomerEmail("not-an-email")).toThrow(CustomerManagementError);
  });

  it("creates a customer and audit record in a single transaction", async () => {
    const customer = {
      id: "cust-1",
      name: "Marcus Vance",
      phone: "+15551234567",
      email: "marcus.v@example.test",
      notes: "Prefers outdoor seating",
      status: "ACTIVE",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    };
    const tx = {
      customer: { create: vi.fn(async () => customer) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)) };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createCustomer({
      restaurantId: "rest-1",
      actorUserId: "user-1",
      name: "  Marcus   Vance ",
      phone: "+15551234567",
      email: "marcus.v@example.test",
      notes: "Prefers outdoor seating",
    });

    expect(result).toMatchObject({
      id: "cust-1",
      name: "Marcus Vance",
      email: "marcus.v@example.test",
      status: "ACTIVE",
    });
    expect(tx.customer.create).toHaveBeenCalledWith({
      data: {
        restaurantId: "rest-1",
        name: "Marcus Vance",
        phone: "+15551234567",
        email: "marcus.v@example.test",
        notes: "Prefers outdoor seating",
      },
      select: expect.any(Object),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        restaurantId: "rest-1",
        userId: "user-1",
        action: "CUSTOMER_CREATED",
        entity: "Customer",
        entityId: "cust-1",
        metadata: { name: "Marcus Vance", phone: "+15551234567", email: "marcus.v@example.test" },
      },
    });
  });

  it("lists active customers scoped to the tenant", async () => {
    const customer = {
      id: "cust-1",
      name: "Marcus Vance",
      phone: null,
      email: null,
      notes: null,
      status: "ACTIVE",
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    };
    const prisma = { customer: { findMany: vi.fn(async () => [customer]) } };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await listCustomers("rest-1");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Marcus Vance");
    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { restaurantId: "rest-1", status: "ACTIVE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: expect.any(Object),
    });
  });
});
