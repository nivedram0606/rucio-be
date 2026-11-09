import { getPrismaClient } from "../db/client";

export type MenuCategoryDto = {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
};

export type MenuItemDto = {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string | null;
  diet: "VEG" | "NON_VEG" | "EGG";
  price: number;
  isAvailable: boolean;
  displayOrder: number;
  createdAt: string;
};

export class MenuManagementError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "CONFLICT" | "NOT_FOUND",
  ) {
    super(message);
    this.name = "MenuManagementError";
  }
}

export function normalizeCategoryName(value: unknown): string {
  if (typeof value !== "string") {
    throw new MenuManagementError("Category name must be text.", "INVALID_INPUT");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length < 1 || normalized.length > 80) {
    throw new MenuManagementError("Category name must be between 1 and 80 characters.", "INVALID_INPUT");
  }
  return normalized;
}

export function normalizeItemName(value: unknown): string {
  if (typeof value !== "string") {
    throw new MenuManagementError("Dish name must be text.", "INVALID_INPUT");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length < 1 || normalized.length > 120) {
    throw new MenuManagementError("Dish name must be between 1 and 120 characters.", "INVALID_INPUT");
  }
  return normalized;
}

export function validatePrice(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || Number.isNaN(numeric) || !Number.isFinite(numeric) || numeric <= 0 || numeric > 100_000) {
    throw new MenuManagementError("Price must be a positive number up to 100,000.", "INVALID_INPUT");
  }
  return Math.round(numeric * 100) / 100;
}

export function validateDiet(value: unknown): "VEG" | "NON_VEG" | "EGG" {
  if (value === undefined || value === null) {
    return "VEG";
  }
  if (value === "VEG" || value === "NON_VEG" || value === "EGG") {
    return value;
  }
  throw new MenuManagementError("Diet must be VEG, NON_VEG, or EGG.", "INVALID_INPUT");
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function listMenuCategories(restaurantId: string): Promise<MenuCategoryDto[]> {
  const prisma = getPrismaClient();
  const categories = await prisma.menuCategory.findMany({
    where: { restaurantId, deletedAt: null },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, displayOrder: true, isActive: true },
  });
  return categories;
}

export async function createMenuCategory(input: {
  restaurantId: string;
  actorUserId: string;
  name: unknown;
  displayOrder?: unknown;
}): Promise<MenuCategoryDto> {
  const name = normalizeCategoryName(input.name);
  const displayOrder = typeof input.displayOrder === "number" && Number.isInteger(input.displayOrder) && input.displayOrder >= 0
    ? input.displayOrder
    : 0;
  const prisma = getPrismaClient();

  try {
    return await prisma.$transaction(async (tx) => {
      const category = await tx.menuCategory.create({
        data: { restaurantId: input.restaurantId, name, displayOrder },
        select: { id: true, name: true, displayOrder: true, isActive: true },
      });
      await tx.auditLog.create({
        data: {
          restaurantId: input.restaurantId,
          userId: input.actorUserId,
          action: "CATEGORY_CREATED",
          entity: "MenuCategory",
          entityId: category.id,
          metadata: { name, displayOrder },
        },
      });
      return category;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new MenuManagementError("A category with that name already exists.", "CONFLICT");
    }
    throw error;
  }
}

export async function listMenuItems(restaurantId: string): Promise<MenuItemDto[]> {
  const prisma = getPrismaClient();
  const items = await prisma.menuItem.findMany({
    where: { restaurantId, deletedAt: null },
    orderBy: [
      { category: { displayOrder: "asc" } },
      { displayOrder: "asc" },
      { name: "asc" },
    ],
    select: {
      id: true,
      categoryId: true,
      name: true,
      description: true,
      diet: true,
      price: true,
      isAvailable: true,
      displayOrder: true,
      createdAt: true,
      category: { select: { name: true } },
    },
  });

  return items.map((item) => ({
    id: item.id,
    categoryId: item.categoryId,
    categoryName: item.category.name,
    name: item.name,
    description: item.description,
    diet: item.diet,
    price: Number(item.price),
    isAvailable: item.isAvailable,
    displayOrder: item.displayOrder,
    createdAt: item.createdAt.toISOString(),
  }));
}

export async function createMenuItem(input: {
  restaurantId: string;
  actorUserId: string;
  categoryId: unknown;
  name: unknown;
  price: unknown;
  description?: unknown;
  diet?: unknown;
  displayOrder?: unknown;
}): Promise<MenuItemDto> {
  if (typeof input.categoryId !== "string" || !input.categoryId.trim()) {
    throw new MenuManagementError("A valid category must be selected.", "INVALID_INPUT");
  }
  const categoryId = input.categoryId.trim();
  const name = normalizeItemName(input.name);
  const price = validatePrice(input.price);
  const diet = validateDiet(input.diet);
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null;
  const displayOrder = typeof input.displayOrder === "number" && Number.isInteger(input.displayOrder) && input.displayOrder >= 0
    ? input.displayOrder
    : 0;

  const prisma = getPrismaClient();

  // Validate category belongs to this restaurant and is active
  const category = await prisma.menuCategory.findFirst({
    where: { id: categoryId, restaurantId: input.restaurantId, deletedAt: null },
    select: { id: true, name: true },
  });

  if (!category) {
    throw new MenuManagementError("The specified category was not found.", "NOT_FOUND");
  }

  return await prisma.$transaction(async (tx) => {
    const item = await tx.menuItem.create({
      data: {
        restaurantId: input.restaurantId,
        categoryId: category.id,
        name,
        price,
        diet,
        description,
        displayOrder,
      },
      select: {
        id: true,
        categoryId: true,
        name: true,
        description: true,
        diet: true,
        price: true,
        isAvailable: true,
        displayOrder: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        restaurantId: input.restaurantId,
        userId: input.actorUserId,
        action: "MENU_ITEM_CREATED",
        entity: "MenuItem",
        entityId: item.id,
        metadata: { categoryId: category.id, name, price, diet },
      },
    });

    return {
      id: item.id,
      categoryId: item.categoryId,
      categoryName: category.name,
      name: item.name,
      description: item.description,
      diet: item.diet,
      price: Number(item.price),
      isAvailable: item.isAvailable,
      displayOrder: item.displayOrder,
      createdAt: item.createdAt.toISOString(),
    };
  });
}
