import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "../db/client";
import {
  createMenuCategory,
  createMenuItem,
  listMenuCategories,
  listMenuItems,
  MenuManagementError,
  normalizeCategoryName,
  normalizeItemName,
  validateDiet,
  validatePrice,
} from "./menu-service";

vi.mock("../db/client", () => ({ getPrismaClient: vi.fn() }));

describe("menu service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes names and validates price and diet", () => {
    expect(normalizeCategoryName("  Starters & Appetizers  ")).toBe("Starters & Appetizers");
    expect(normalizeItemName("  Truffle Fries  ")).toBe("Truffle Fries");
    expect(validatePrice("12.50")).toBe(12.5);
    expect(validatePrice(250)).toBe(250);
    expect(validateDiet(undefined)).toBe("VEG");
    expect(validateDiet("NON_VEG")).toBe("NON_VEG");
    expect(validateDiet("EGG")).toBe("EGG");

    expect(() => normalizeCategoryName("")).toThrow(MenuManagementError);
    expect(() => normalizeItemName("")).toThrow(MenuManagementError);
    expect(() => validatePrice(-10)).toThrow(MenuManagementError);
    expect(() => validatePrice(0)).toThrow(MenuManagementError);
    expect(() => validateDiet("INVALID")).toThrow(MenuManagementError);
  });

  it("creates a tenant-scoped category and audit log in one transaction", async () => {
    const category = { id: "cat-1", name: "Desserts", displayOrder: 1, isActive: true };
    const tx = {
      menuCategory: { create: vi.fn(async () => category) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)) };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createMenuCategory({
      restaurantId: "rest-1",
      actorUserId: "user-1",
      name: " Desserts ",
      displayOrder: 1,
    });

    expect(result).toMatchObject({ id: "cat-1", name: "Desserts", displayOrder: 1 });
    expect(tx.menuCategory.create).toHaveBeenCalledWith({
      data: { restaurantId: "rest-1", name: "Desserts", displayOrder: 1 },
      select: { id: true, name: true, displayOrder: true, isActive: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        restaurantId: "rest-1",
        userId: "user-1",
        action: "CATEGORY_CREATED",
        entity: "MenuCategory",
        entityId: "cat-1",
        metadata: { name: "Desserts", displayOrder: 1 },
      },
    });
  });

  it("maps category name conflict to a safe CONFLICT error", async () => {
    const tx = {
      menuCategory: { create: vi.fn(async () => { throw { code: "P2002" }; }) },
      auditLog: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)) };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(createMenuCategory({ restaurantId: "rest-1", actorUserId: "user-1", name: "Mains" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "A category with that name already exists." });
  });

  it("creates a tenant-scoped menu item and verifies category ownership", async () => {
    const category = { id: "cat-1", name: "Starters" };
    const item = {
      id: "item-1",
      categoryId: "cat-1",
      name: "Crispy Calamari",
      description: "With garlic aioli",
      diet: "NON_VEG",
      price: 18.5,
      isAvailable: true,
      displayOrder: 0,
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    };
    const tx = {
      menuItem: { create: vi.fn(async () => item) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      menuCategory: { findFirst: vi.fn(async () => category) },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const result = await createMenuItem({
      restaurantId: "rest-1",
      actorUserId: "user-1",
      categoryId: "cat-1",
      name: " Crispy Calamari ",
      price: "18.50",
      diet: "NON_VEG",
      description: "With garlic aioli",
    });

    expect(result).toMatchObject({
      id: "item-1",
      categoryName: "Starters",
      name: "Crispy Calamari",
      price: 18.5,
      diet: "NON_VEG",
    });
    expect(prisma.menuCategory.findFirst).toHaveBeenCalledWith({
      where: { id: "cat-1", restaurantId: "rest-1", deletedAt: null },
      select: { id: true, name: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        restaurantId: "rest-1",
        userId: "user-1",
        action: "MENU_ITEM_CREATED",
        entity: "MenuItem",
        entityId: "item-1",
        metadata: { categoryId: "cat-1", name: "Crispy Calamari", price: 18.5, diet: "NON_VEG" },
      },
    });
  });

  it("rejects creating a menu item if category does not belong to session restaurant", async () => {
    const prisma = {
      menuCategory: { findFirst: vi.fn(async () => null) },
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    await expect(createMenuItem({
      restaurantId: "rest-1",
      actorUserId: "user-1",
      categoryId: "foreign-cat-id",
      name: "Pasta",
      price: 15,
    })).rejects.toMatchObject({ code: "NOT_FOUND", message: "The specified category was not found." });
  });

  it("lists active categories and items", async () => {
    const prisma = {
      menuCategory: {
        findMany: vi.fn(async () => [{ id: "cat-1", name: "Drinks", displayOrder: 0, isActive: true }]),
      },
      menuItem: {
        findMany: vi.fn(async () => [{
          id: "item-1",
          categoryId: "cat-1",
          name: "Lemonade",
          description: null,
          diet: "VEG",
          price: 5,
          isAvailable: true,
          displayOrder: 0,
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
          category: { name: "Drinks" },
        }]),
      },
    };
    vi.mocked(getPrismaClient).mockReturnValue(prisma as never);

    const categories = await listMenuCategories("rest-1");
    expect(categories).toEqual([{ id: "cat-1", name: "Drinks", displayOrder: 0, isActive: true }]);

    const items = await listMenuItems("rest-1");
    expect(items).toEqual([{
      id: "item-1",
      categoryId: "cat-1",
      categoryName: "Drinks",
      name: "Lemonade",
      description: null,
      diet: "VEG",
      price: 5,
      isAvailable: true,
      displayOrder: 0,
      createdAt: "2026-11-01T00:00:00.000Z",
    }]);
  });
});
