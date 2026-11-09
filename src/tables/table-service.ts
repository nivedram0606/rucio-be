import { getPrismaClient } from "../db/client";

export type RestaurantTableDto = {
  id: string;
  tableNumber: string;
  capacity: number;
  status: string;
  createdAt: string;
};

export class TableManagementError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "CONFLICT" | "NOT_FOUND",
  ) {
    super(message);
    this.name = "TableManagementError";
  }
}

export const VALID_TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "RESERVED", "BILLING", "CLEANING"] as const;
export type TableStatusValue = typeof VALID_TABLE_STATUSES[number];

export function validateTableStatus(value: unknown): TableStatusValue {
  if (typeof value !== "string" || !VALID_TABLE_STATUSES.includes(value as TableStatusValue)) {
    throw new TableManagementError(
      `Status must be one of: ${VALID_TABLE_STATUSES.join(", ")}.`,
      "INVALID_INPUT",
    );
  }
  return value as TableStatusValue;
}

export function normalizeTableNumber(value: unknown): string {
  if (typeof value !== "string") {
    throw new TableManagementError("Table number must be text.", "INVALID_INPUT");
  }
  const normalized = value.trim().replace(/\s+/g, " ").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 -]{0,19}$/.test(normalized)) {
    throw new TableManagementError("Use 1–20 letters, numbers, spaces, or hyphens; start with a letter or number.", "INVALID_INPUT");
  }
  return normalized;
}

export function validateTableCapacity(value: unknown): number {
  const capacity = value === undefined ? 4 : value;
  if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 50) {
    throw new TableManagementError("Capacity must be a whole number from 1 to 50.", "INVALID_INPUT");
  }
  return capacity as number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function toDto(table: {
  id: string;
  tableNumber: string;
  capacity: number;
  status: string;
  createdAt: Date;
}): RestaurantTableDto {
  return {
    id: table.id,
    tableNumber: table.tableNumber,
    capacity: table.capacity,
    status: table.status,
    createdAt: table.createdAt.toISOString(),
  };
}

export async function listRestaurantTables(restaurantId: string): Promise<RestaurantTableDto[]> {
  const prisma = getPrismaClient();
  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId, deletedAt: null },
    orderBy: [{ tableNumber: "asc" }, { id: "asc" }],
    select: { id: true, tableNumber: true, capacity: true, status: true, createdAt: true },
  });
  return tables.map(toDto);
}

export async function createRestaurantTable(input: {
  restaurantId: string;
  actorUserId: string;
  tableNumber: unknown;
  capacity?: unknown;
}): Promise<RestaurantTableDto> {
  const tableNumber = normalizeTableNumber(input.tableNumber);
  const capacity = validateTableCapacity(input.capacity);
  const prisma = getPrismaClient();

  try {
    return await prisma.$transaction(async (tx) => {
      const table = await tx.restaurantTable.create({
        data: { restaurantId: input.restaurantId, tableNumber, capacity },
        select: { id: true, tableNumber: true, capacity: true, status: true, createdAt: true },
      });
      await tx.auditLog.create({
        data: {
          restaurantId: input.restaurantId,
          userId: input.actorUserId,
          action: "TABLE_CREATED",
          entity: "RestaurantTable",
          entityId: table.id,
          metadata: { tableNumber, capacity },
        },
      });
      return toDto(table);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new TableManagementError("A table with that number already exists.", "CONFLICT");
    }
    throw error;
  }
}

export async function updateRestaurantTableStatus(input: {
  restaurantId: string;
  actorUserId: string;
  tableId: string;
  status: unknown;
}): Promise<RestaurantTableDto> {
  const status = validateTableStatus(input.status);
  const prisma = getPrismaClient();

  const existing = await prisma.restaurantTable.findFirst({
    where: { id: input.tableId, restaurantId: input.restaurantId, deletedAt: null },
  });

  if (!existing) {
    throw new TableManagementError("Table not found.", "NOT_FOUND");
  }

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.restaurantTable.update({
      where: { id: input.tableId },
      data: { status: status as never },
      select: { id: true, tableNumber: true, capacity: true, status: true, createdAt: true },
    });

    await tx.auditLog.create({
      data: {
        restaurantId: input.restaurantId,
        userId: input.actorUserId,
        action: "TABLE_STATUS_UPDATED",
        entity: "RestaurantTable",
        entityId: updated.id,
        metadata: {
          tableNumber: updated.tableNumber,
          oldStatus: existing.status,
          newStatus: status,
        },
      },
    });

    return toDto(updated);
  });
}

