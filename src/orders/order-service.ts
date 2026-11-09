import { getPrismaClient } from "../db/client";

export type OrderItemInput = {
  menuItemId: string;
  quantity: number;
  instructions?: string;
};

export type CreateOrderInput = {
  restaurantId: string;
  actorUserId: string;
  tableNumber?: unknown;
  type?: unknown;
  notes?: unknown;
  items: unknown;
};

export type OrderItemDto = {
  id: string;
  menuItemId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  instructions: string | null;
};

export type KotTicketDto = {
  id: string;
  kotNumber: string;
  status: "NEW" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  createdAt: string;
};

export type OrderDto = {
  id: string;
  orderNumber: string;
  tableNumber: string | null;
  type: "DINE_IN" | "TAKEAWAY";
  status: string;
  paymentMethod?: "CASH" | "UPI" | "CARD" | null;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  notes: string | null;
  createdAt: string;
  items: OrderItemDto[];
  kots: KotTicketDto[];
};

export class OrderManagementError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN",
  ) {
    super(message);
    this.name = "OrderManagementError";
  }
}

export function validateOrderItems(items: unknown): OrderItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderManagementError("Order must include at least one item.", "INVALID_INPUT");
  }
  return items.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new OrderManagementError(`Item at index ${index} must be an object.`, "INVALID_INPUT");
    }
    const { menuItemId, quantity, instructions } = item as Record<string, unknown>;
    if (typeof menuItemId !== "string" || !menuItemId.trim()) {
      throw new OrderManagementError(`Item at index ${index} must include a valid menuItemId.`, "INVALID_INPUT");
    }
    const qty = typeof quantity === "number" ? quantity : Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100) {
      throw new OrderManagementError(`Item at index ${index} quantity must be a positive whole number up to 100.`, "INVALID_INPUT");
    }
    const cleanInstructions = typeof instructions === "string" ? instructions.trim() : undefined;
    return {
      menuItemId: menuItemId.trim(),
      quantity: qty,
      instructions: cleanInstructions || undefined,
    };
  });
}

export async function listOrders(restaurantId: string): Promise<OrderDto[]> {
  const prisma = getPrismaClient();
  const orders = await prisma.order.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
    include: {
      items: true,
      kots: true,
    },
  });

  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    tableNumber: o.notes?.startsWith("Table: ") ? o.notes.slice(7) : null,
    type: o.type as "DINE_IN" | "TAKEAWAY",
    status: o.status,
    subtotal: Number(o.subtotal),
    taxTotal: Number(o.taxTotal),
    grandTotal: Number(o.grandTotal),
    notes: o.notes,
    createdAt: o.createdAt.toISOString(),
    items: o.items.map((i) => ({
      id: i.id,
      menuItemId: i.menuItemId,
      itemName: i.itemName,
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
      taxRate: Number(i.taxRate),
      taxAmount: Number(i.taxAmount),
      total: Number(i.total),
      instructions: i.instructions,
    })),
    kots: o.kots.map((k) => ({
      id: k.id,
      kotNumber: k.kotNumber,
      status: k.status as "NEW" | "PREPARING" | "READY" | "SERVED" | "CANCELLED",
      createdAt: k.createdAt.toISOString(),
    })),
  }));
}

export async function createOrder(input: CreateOrderInput): Promise<OrderDto> {
  const { restaurantId, actorUserId } = input;
  const items = validateOrderItems(input.items);

  const orderType = input.type === "TAKEAWAY" ? "PARCEL" : "DINE_IN";
  const rawTableNumber = typeof input.tableNumber === "string" ? input.tableNumber.trim().toUpperCase() : undefined;
  const orderNotes = rawTableNumber ? `Table: ${rawTableNumber}` : (typeof input.notes === "string" ? input.notes.trim() : null);

  const prisma = getPrismaClient();

  // Fetch and validate menu items belonging to this restaurant
  const menuItemIds = items.map((i) => i.menuItemId);
  const foundMenuItems = await prisma.menuItem.findMany({
    where: {
      id: { in: menuItemIds },
      restaurantId,
      deletedAt: null,
      isAvailable: true,
    },
  });

  if (foundMenuItems.length !== menuItemIds.length) {
    throw new OrderManagementError("One or more menu items are invalid, unavailable, or do not belong to this restaurant.", "INVALID_INPUT");
  }

  const itemMap = new Map(foundMenuItems.map((m) => [m.id, m]));

  // Calculate totals
  let subtotal = 0;
  let taxTotal = 0;

  const orderItemCalculations = items.map((item) => {
    const menuItem = itemMap.get(item.menuItemId)!;
    const unitPrice = Number(menuItem.price);
    const taxRate = 0.05;
    const lineSubtotal = Math.round(unitPrice * item.quantity * 100) / 100;
    const lineTax = Math.round(lineSubtotal * taxRate * 100) / 100;
    const lineTotal = lineSubtotal;

    subtotal += lineSubtotal;
    taxTotal += lineTax;

    return {
      menuItemId: menuItem.id,
      itemName: menuItem.name,
      quantity: item.quantity,
      unitPrice,
      taxRate,
      taxAmount: lineTax,
      total: lineTotal,
      instructions: item.instructions ?? null,
    };
  });

  const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

  return await prisma.$transaction(async (tx) => {
    // Generate sequential order and KOT numbers
    const existingOrderCount = await tx.order.count({ where: { restaurantId } });
    const orderNumber = `ORD-${String(existingOrderCount + 1).padStart(4, "0")}`;
    const kotNumber = `KOT-${String(existingOrderCount + 1).padStart(4, "0")}`;

    const order = await tx.order.create({
      data: {
        restaurantId,
        orderNumber,
        type: orderType,
        source: "STAFF_POS",
        status: "PLACED",
        createdById: actorUserId,
        notes: orderNotes,
        subtotal,
        taxTotal,
        grandTotal,
        items: {
          create: orderItemCalculations.map((i) => ({
            menuItemId: i.menuItemId,
            itemName: i.itemName,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            taxRate: i.taxRate,
            taxAmount: i.taxAmount,
            total: i.total,
            instructions: i.instructions,
          })),
        },
      },
      include: {
        items: true,
      },
    });

    const createdItems = (order as typeof order & { items: Array<{ id: string; quantity: number }> }).items;

    // Create KOT ticket for kitchen
    const kot = await tx.kotTicket.create({
      data: {
        restaurantId,
        orderId: order.id,
        kotNumber,
        status: "NEW",
        items: {
          create: createdItems.map((oi) => ({
            orderItemId: oi.id,
            quantity: oi.quantity,
            status: "NEW",
          })),
        },
      },
    });

    // Create Audit Log
    await tx.auditLog.create({
      data: {
        restaurantId,
        userId: actorUserId,
        action: "ORDER_CREATED",
        entity: "Order",
        entityId: order.id,
        metadata: {
          orderNumber: order.orderNumber,
          kotNumber: kot.kotNumber,
          grandTotal: Number(order.grandTotal),
          itemCount: createdItems.length,
        },
      },
    });

    const responseItems = (order as typeof order & {
      items: Array<{
        id: string;
        menuItemId: string;
        itemName: string;
        quantity: number;
        unitPrice: unknown;
        taxRate: unknown;
        taxAmount: unknown;
        total: unknown;
        instructions: string | null;
      }>;
    }).items;

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      tableNumber: rawTableNumber ?? null,
      type: (order.type === "PARCEL" ? "TAKEAWAY" : "DINE_IN") as "DINE_IN" | "TAKEAWAY",
      status: order.status,
      subtotal: Number(order.subtotal),
      taxTotal: Number(order.taxTotal),
      grandTotal: Number(order.grandTotal),
      notes: order.notes,
      createdAt: order.createdAt.toISOString(),
      items: responseItems.map((i) => ({
        id: i.id,
        menuItemId: i.menuItemId,
        itemName: i.itemName,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        taxRate: Number(i.taxRate),
        taxAmount: Number(i.taxAmount),
        total: Number(i.total),
        instructions: i.instructions,
      })),
      kots: [
        {
          id: kot.id,
          kotNumber: kot.kotNumber,
          status: kot.status as "NEW",
          createdAt: kot.createdAt.toISOString(),
        },
      ],
    };
  });
}

export async function updateKotStatus(input: {
  restaurantId: string;
  actorUserId: string;
  kotId: string;
  status: unknown;
}): Promise<KotTicketDto> {
  const { restaurantId, actorUserId, kotId } = input;
  const validStatuses = ["NEW", "PREPARING", "READY", "SERVED", "CANCELLED"] as const;
  if (typeof input.status !== "string" || !validStatuses.includes(input.status as typeof validStatuses[number])) {
    throw new OrderManagementError("Status must be one of: NEW, PREPARING, READY, SERVED, CANCELLED.", "INVALID_INPUT");
  }

  const targetStatus = input.status as typeof validStatuses[number];
  const prisma = getPrismaClient();

  const kot = await prisma.kotTicket.findFirst({
    where: { id: kotId, restaurantId },
  });

  if (!kot) {
    throw new OrderManagementError("Kitchen ticket not found.", "NOT_FOUND");
  }

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.kotTicket.update({
      where: { id: kotId },
      data: { status: targetStatus },
    });

    await tx.auditLog.create({
      data: {
        restaurantId,
        userId: actorUserId,
        action: "KOT_STATUS_UPDATED",
        entity: "KotTicket",
        entityId: kotId,
        metadata: {
          oldStatus: kot.status,
          newStatus: targetStatus,
        },
      },
    });

    return {
      id: updated.id,
      kotNumber: updated.kotNumber,
      status: updated.status as typeof targetStatus,
      createdAt: updated.createdAt.toISOString(),
    };
  });
}

export async function settleOrder(input: {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  paymentMethod: unknown;
}): Promise<OrderDto> {
  const { restaurantId, actorUserId, orderId } = input;
  const validMethods = ["CASH", "UPI", "CARD"] as const;
  if (typeof input.paymentMethod !== "string" || !validMethods.includes(input.paymentMethod as typeof validMethods[number])) {
    throw new OrderManagementError("Payment method must be one of: CASH, UPI, CARD.", "INVALID_INPUT");
  }
  const method = input.paymentMethod as typeof validMethods[number];
  const prisma = getPrismaClient();

  const order = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    include: { items: true, kots: true },
  });

  if (!order) {
    throw new OrderManagementError("Order not found.", "NOT_FOUND");
  }

  return await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: "SETTLED" },
      include: { items: true, kots: true },
    });

    await tx.kotTicket.updateMany({
      where: { orderId, restaurantId, status: { notIn: ["SERVED", "CANCELLED"] } },
      data: { status: "SERVED" },
    });

    await tx.auditLog.create({
      data: {
        restaurantId,
        userId: actorUserId,
        action: "ORDER_SETTLED",
        entity: "Order",
        entityId: orderId,
        metadata: {
          orderNumber: order.orderNumber,
          paymentMethod: method,
          grandTotal: Number(order.grandTotal),
        },
      },
    });

    const refreshedKots = await tx.kotTicket.findMany({
      where: { orderId, restaurantId },
    });

    return {
      id: updated.id,
      orderNumber: updated.orderNumber,
      tableNumber: updated.notes?.startsWith("Table: ") ? updated.notes.slice(7) : null,
      type: updated.type as "DINE_IN" | "TAKEAWAY",
      status: "SETTLED",
      paymentMethod: method,
      subtotal: Number(updated.subtotal),
      taxTotal: Number(updated.taxTotal),
      grandTotal: Number(updated.grandTotal),
      notes: updated.notes,
      createdAt: updated.createdAt.toISOString(),
      items: updated.items.map((i) => ({
        id: i.id,
        menuItemId: i.menuItemId,
        itemName: i.itemName,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        taxRate: Number(i.taxRate),
        taxAmount: Number(i.taxAmount),
        total: Number(i.total),
        instructions: i.instructions,
      })),
      kots: refreshedKots.map((k) => ({
        id: k.id,
        kotNumber: k.kotNumber,
        status: k.status as "NEW" | "PREPARING" | "READY" | "SERVED" | "CANCELLED",
        createdAt: k.createdAt.toISOString(),
      })),
    };
  });
}
