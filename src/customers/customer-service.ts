import { getPrismaClient } from "../db/client";

export type CustomerDto = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: string;
  createdAt: string;
};

export class CustomerManagementError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "CONFLICT",
  ) {
    super(message);
    this.name = "CustomerManagementError";
  }
}

export function normalizeCustomerName(value: unknown): string {
  if (typeof value !== "string") {
    throw new CustomerManagementError("Customer name must be text.", "INVALID_INPUT");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 100) {
    throw new CustomerManagementError("Customer name must be between 1 and 100 characters.", "INVALID_INPUT");
  }
  return normalized;
}

export function normalizeCustomerPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new CustomerManagementError("Phone number must be text.", "INVALID_INPUT");
  }
  const trimmed = value.trim();
  if (trimmed.length > 30) {
    throw new CustomerManagementError("Phone number must not exceed 30 characters.", "INVALID_INPUT");
  }
  return trimmed;
}

export function normalizeCustomerEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new CustomerManagementError("Email address must be text.", "INVALID_INPUT");
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new CustomerManagementError("Please provide a valid email address.", "INVALID_INPUT");
  }
  return trimmed;
}

function toDto(customer: {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: string;
  createdAt: Date;
}): CustomerDto {
  return {
    id: customer.id,
    name: customer.name || "Guest",
    phone: customer.phone,
    email: customer.email,
    notes: customer.notes,
    status: customer.status,
    createdAt: customer.createdAt.toISOString(),
  };
}

export async function listCustomers(restaurantId: string): Promise<CustomerDto[]> {
  const prisma = getPrismaClient();
  const customers = await prisma.customer.findMany({
    where: { restaurantId, status: "ACTIVE" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      notes: true,
      status: true,
      createdAt: true,
    },
  });
  return customers.map(toDto);
}

export async function createCustomer(input: {
  restaurantId: string;
  actorUserId: string;
  name: unknown;
  phone?: unknown;
  email?: unknown;
  notes?: unknown;
}): Promise<CustomerDto> {
  const name = normalizeCustomerName(input.name);
  const phone = normalizeCustomerPhone(input.phone);
  const email = normalizeCustomerEmail(input.email);
  const notes = typeof input.notes === "string" ? input.notes.trim() || null : null;

  const prisma = getPrismaClient();

  return await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        restaurantId: input.restaurantId,
        name,
        phone,
        email,
        notes,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        notes: true,
        status: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        restaurantId: input.restaurantId,
        userId: input.actorUserId,
        action: "CUSTOMER_CREATED",
        entity: "Customer",
        entityId: customer.id,
        metadata: { name, phone, email },
      },
    });

    return toDto(customer);
  });
}
