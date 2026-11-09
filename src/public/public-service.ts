import { getPrismaClient } from "../db/client";
import type { MenuCategoryDto, MenuItemDto } from "../menu/menu-service";
import type { OrderDto } from "../orders/order-service";
import { validateOrderItems } from "../orders/order-service";

export class PublicOrderError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT",
  ) {
    super(message);
    this.name = "PublicOrderError";
  }
}

export type PublicMenuDto = {
  restaurant: {
    id: string;
    name: string;
    slug: string;
  };
  categories: MenuCategoryDto[];
  items: MenuItemDto[];
};

export async function getPublicMenuBySlug(slug: string): Promise<PublicMenuDto> {
  const normalizedSlug = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  if (!normalizedSlug) {
    throw new PublicOrderError("Restaurant slug is required.", "INVALID_INPUT");
  }

  const prisma = getPrismaClient();
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: normalizedSlug },
    select: { id: true, name: true, slug: true, status: true, deletedAt: true },
  });

  if (!restaurant || restaurant.status !== "ACTIVE" || restaurant.deletedAt !== null) {
    throw new PublicOrderError("Restaurant not found.", "NOT_FOUND");
  }

  const [categories, items] = await Promise.all([
    prisma.menuCategory.findMany({
      where: { restaurantId: restaurant.id, deletedAt: null, isActive: true },
      orderBy: { displayOrder: "asc" },
      select: { id: true, name: true, displayOrder: true, isActive: true },
    }),
    prisma.menuItem.findMany({
      where: { restaurantId: restaurant.id, deletedAt: null, isAvailable: true },
      orderBy: { displayOrder: "asc" },
      include: { category: { select: { name: true } } },
    }),
  ]);

  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
    },
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      displayOrder: c.displayOrder,
      isActive: c.isActive,
    })),
    items: items.map((i) => ({
      id: i.id,
      categoryId: i.categoryId,
      categoryName: i.category.name,
      name: i.name,
      description: i.description,
      diet: i.diet as "VEG" | "NON_VEG" | "EGG",
      price: Number(i.price),
      isAvailable: i.isAvailable,
      displayOrder: i.displayOrder,
      createdAt: i.createdAt.toISOString(),
    })),
  };
}

export async function createPublicOrder(input: {
  slug: string;
  tableNumber: string;
  customerName?: string;
  phone?: string;
  notes?: string;
  items: unknown;
}): Promise<OrderDto> {
  const normalizedSlug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
  if (!normalizedSlug) {
    throw new PublicOrderError("Restaurant slug is required.", "INVALID_INPUT");
  }

  const rawTable = typeof input.tableNumber === "string" ? input.tableNumber.trim().toUpperCase() : "";
  if (!rawTable) {
    throw new PublicOrderError("Table identifier is required.", "INVALID_INPUT");
  }

  const items = validateOrderItems(input.items);
  const prisma = getPrismaClient();

  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: normalizedSlug },
    select: { id: true, name: true, slug: true, status: true, deletedAt: true },
  });

  if (!restaurant || restaurant.status !== "ACTIVE" || restaurant.deletedAt !== null) {
    throw new PublicOrderError("Restaurant not found.", "NOT_FOUND");
  }

  const restaurantId = restaurant.id;
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
    throw new PublicOrderError("One or more selected menu items are unavailable.", "INVALID_INPUT");
  }

  const itemMap = new Map(foundMenuItems.map((m) => [m.id, m]));
  let subtotal = 0;
  let taxTotal = 0;

  const orderItemCalculations = items.map((item) => {
    const menuItem = itemMap.get(item.menuItemId)!;
    const unitPrice = Number(menuItem.price);
    const taxRate = 0.05;
    const lineSubtotal = Math.round(unitPrice * item.quantity * 100) / 100;
    const lineTax = Math.round(lineSubtotal * taxRate * 100) / 100;

    subtotal += lineSubtotal;
    taxTotal += lineTax;

    return {
      menuItemId: menuItem.id,
      itemName: menuItem.name,
      quantity: item.quantity,
      unitPrice,
      taxRate,
      taxAmount: lineTax,
      total: lineSubtotal,
      instructions: item.instructions ?? null,
    };
  });

  const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;
  const guestLabel = input.customerName ? `Guest: ${input.customerName.trim()} · Table: ${rawTable}` : `Table: ${rawTable}`;
  const orderNotes = input.notes ? `${guestLabel} (${input.notes.trim()})` : guestLabel;

  return await prisma.$transaction(async (tx) => {
    const existingOrderCount = await tx.order.count({ where: { restaurantId } });
    const orderNumber = `ORD-${String(existingOrderCount + 1).padStart(4, "0")}`;
    const kotNumber = `KOT-${String(existingOrderCount + 1).padStart(4, "0")}`;

    const order = await tx.order.create({
      data: {
        restaurantId,
        orderNumber,
        type: "DINE_IN",
        source: "QR_CUSTOMER",
        status: "PLACED",
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
      include: { items: true },
    });

    const kot = await tx.kotTicket.create({
      data: {
        restaurantId,
        orderId: order.id,
        kotNumber,
        status: "NEW",
        items: {
          create: order.items.map((oi) => ({
            orderItemId: oi.id,
            quantity: oi.quantity,
            status: "NEW",
          })),
        },
      },
    });

    await tx.auditLog.create({
      data: {
        restaurantId,
        action: "CUSTOMER_ORDER_PLACED",
        entity: "Order",
        entityId: order.id,
        metadata: {
          orderNumber: order.orderNumber,
          kotNumber: kot.kotNumber,
          tableNumber: rawTable,
          grandTotal: Number(order.grandTotal),
          source: "QR_CUSTOMER",
        },
      },
    });

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      tableNumber: rawTable,
      type: "DINE_IN",
      status: order.status,
      subtotal: Number(order.subtotal),
      taxTotal: Number(order.taxTotal),
      grandTotal: Number(order.grandTotal),
      notes: order.notes,
      createdAt: order.createdAt.toISOString(),
      items: order.items.map((i) => ({
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

export async function getPublicOrderStatus(slug: string, orderNumber: string): Promise<OrderDto | null> {
  const normalizedSlug = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  const normalizedOrderNumber = typeof orderNumber === "string" ? orderNumber.trim().toUpperCase() : "";

  if (!normalizedSlug || !normalizedOrderNumber) return null;

  const prisma = getPrismaClient();
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: normalizedSlug },
    select: { id: true },
  });

  if (!restaurant) return null;

  const order = await prisma.order.findFirst({
    where: { restaurantId: restaurant.id, orderNumber: normalizedOrderNumber },
    include: { items: true, kots: true },
  });

  if (!order) return null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    tableNumber: order.notes?.includes("Table: ") ? order.notes.split("Table: ")[1]?.split(" ")[0] ?? null : null,
    type: (order.type === "PARCEL" ? "TAKEAWAY" : "DINE_IN") as "DINE_IN" | "TAKEAWAY",
    status: order.status,
    subtotal: Number(order.subtotal),
    taxTotal: Number(order.taxTotal),
    grandTotal: Number(order.grandTotal),
    notes: order.notes,
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((i) => ({
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
    kots: order.kots.map((k) => ({
      id: k.id,
      kotNumber: k.kotNumber,
      status: k.status as "NEW" | "PREPARING" | "READY" | "SERVED" | "CANCELLED",
      createdAt: k.createdAt.toISOString(),
    })),
  };
}
