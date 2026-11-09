import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildApp } from "../../src/app";
import { OnboardingError, type OnboardedRestaurant } from "../../src/onboarding/create-restaurant";
import { AuthError, type AuthIdentity } from "../../src/auth/auth-service";
import { TableManagementError, type RestaurantTableDto } from "../../src/tables/table-service";
import {
  MenuManagementError,
  type MenuCategoryDto,
  type MenuItemDto,
} from "../../src/menu/menu-service";
import {
  OrderManagementError,
  type OrderDto,
  type KotTicketDto,
} from "../../src/orders/order-service";
import {
  CustomerManagementError,
  type CustomerDto,
} from "../../src/customers/customer-service";
import {
  StaffManagementError,
  type StaffMemberDto,
} from "../../src/staff/staff-service";
import { PublicOrderError } from "../../src/public/public-service";

type InMemUser = {
  id: string;
  name: string;
  email: string;
  password: string;
  status: "ACTIVE" | "INACTIVE";
  deletedAt: Date | null;
  restaurant: {
    id: string;
    name: string;
    slug: string;
    status: "ACTIVE" | "INACTIVE";
    deletedAt: Date | null;
  };
  roles: string[];
  permissions: string[];
};

type InMemSession = {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

const users = new Map<string, InMemUser>();
const sessions = new Map<string, InMemSession>();
const tablesByRestaurant = new Map<string, RestaurantTableDto[]>();
const categoriesByRestaurant = new Map<string, MenuCategoryDto[]>();
const itemsByRestaurant = new Map<string, MenuItemDto[]>();
const ordersByRestaurant = new Map<string, OrderDto[]>();
const customersByRestaurant = new Map<string, CustomerDto[]>();
const staffByRestaurant = new Map<string, StaffMemberDto[]>();

// Seed default fixture Admin
users.set("admin@example.test", {
  id: "820bf849-ad8d-4179-b1f3-6c11693087d8",
  name: "Test Admin",
  email: "admin@example.test",
  password: "test-password-long-enough-123",
  status: "ACTIVE",
  deletedAt: null,
  restaurant: {
    id: "8fcf83a8-5993-4331-95df-a10ffae7b45f",
    name: "Playwright Bistro",
    slug: "playwright-bistro",
    status: "ACTIVE",
    deletedAt: null,
  },
  roles: ["Admin", "Manager", "Cashier", "Waiter", "Kitchen Staff"],
  permissions: [
    "tables.view",
    "tables.create",
    "menu.view",
    "menu.create",
    "orders.view",
    "orders.create",
    "kot.view",
    "kot.update_status",
    "customers.view",
    "customers.create",
    "users.view",
    "users.create",
  ],
});

// Seed edge cases for security testing
users.set("inactive@example.test", {
  id: "inactive-user-id",
  name: "Inactive User",
  email: "inactive@example.test",
  password: "test-password-long-enough-123",
  status: "INACTIVE",
  deletedAt: null,
  restaurant: {
    id: "8fcf83a8-5993-4331-95df-a10ffae7b45f",
    name: "Playwright Bistro",
    slug: "playwright-bistro",
    status: "ACTIVE",
    deletedAt: null,
  },
  roles: ["Admin"],
  permissions: ["tables.view", "tables.create"],
});

users.set("inactive-bistro@example.test", {
  id: "inactive-bistro-admin",
  name: "Closed Bistro Admin",
  email: "inactive-bistro@example.test",
  password: "test-password-long-enough-123",
  status: "ACTIVE",
  deletedAt: null,
  restaurant: {
    id: "closed-restaurant-id",
    name: "Closed Bistro",
    slug: "closed-bistro",
    status: "INACTIVE",
    deletedAt: null,
  },
  roles: ["Admin"],
  permissions: ["tables.view", "tables.create"],
});

users.set("viewer@example.test", {
  id: "tables-viewer-user",
  name: "Tables Viewer",
  email: "viewer@example.test",
  password: "test-password-long-enough-123",
  status: "ACTIVE",
  deletedAt: null,
  restaurant: {
    id: "8fcf83a8-5993-4331-95df-a10ffae7b45f",
    name: "Playwright Bistro",
    slug: "playwright-bistro",
    status: "ACTIVE",
    deletedAt: null,
  },
  roles: ["Kitchen Staff"],
  permissions: [],
});

users.set("second-admin@example.test", {
  id: "second-admin-user",
  name: "Second Admin",
  email: "second-admin@example.test",
  password: "test-password-long-enough-123",
  status: "ACTIVE",
  deletedAt: null,
  restaurant: {
    id: "second-restaurant-id",
    name: "Second Bistro",
    slug: "second-bistro",
    status: "ACTIVE",
    deletedAt: null,
  },
  roles: ["Admin"],
  permissions: ["tables.view", "tables.create", "menu.view", "menu.create", "orders.view", "orders.create", "kot.view", "kot.update_status"],
});

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const app = await buildApp({
  onboardingKey: process.env.ONBOARDING_API_KEY,
  logger: false,
  onboard: async (input): Promise<OnboardedRestaurant> => {
    if (input.restaurantSlug === "duplicate-restaurant") {
      throw new OnboardingError("That restaurant URL or admin email is already in use.", "CONFLICT");
    }

    const email = input.ownerEmail.trim().toLowerCase();
    const slug = input.restaurantSlug?.toLowerCase() ?? "sample-restaurant";

    const onboarded: OnboardedRestaurant = {
      restaurant: {
        id: "8fcf83a8-5993-4331-95df-a10ffae7b45f",
        name: input.restaurantName.trim(),
        slug,
      },
      admin: {
        id: "820bf849-ad8d-4179-b1f3-6c11693087d8",
        name: input.ownerName.trim(),
        email,
      },
      roles: ["Admin", "Manager", "Cashier", "Waiter", "Kitchen Staff"],
    };

    // Store in-memory so Playwright tests can sign in with newly onboarded restaurants
    users.set(email, {
      id: onboarded.admin.id,
      name: onboarded.admin.name,
      email,
      password: input.ownerPassword,
      status: "ACTIVE",
      deletedAt: null,
      restaurant: {
        id: onboarded.restaurant.id,
        name: onboarded.restaurant.name,
        slug: onboarded.restaurant.slug,
        status: "ACTIVE",
        deletedAt: null,
      },
      roles: onboarded.roles,
      permissions: [
        "tables.view",
        "tables.create",
        "menu.view",
        "menu.create",
        "orders.view",
        "orders.create",
        "kot.view",
        "kot.update_status",
        "customers.view",
        "customers.create",
        "users.view",
        "users.create",
      ],
    });

    return onboarded;
  },
  auth: {
    login: async (emailInput, passwordInput) => {
      const email = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
      const user = users.get(email);
      if (!user) {
        throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
      }
      if (user.status !== "ACTIVE" || user.deletedAt !== null) {
        throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
      }
      if (user.restaurant.status !== "ACTIVE" || user.restaurant.deletedAt !== null) {
        throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
      }
      if (user.password !== passwordInput) {
        throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
      }

      const sessionToken = randomBytes(32).toString("base64url");
      const tokenHash = hashSessionToken(sessionToken);
      sessions.set(tokenHash, {
        tokenHash,
        userId: user.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        revokedAt: null,
      });

      const identity: AuthIdentity = {
        user: { id: user.id, name: user.name, email: user.email },
        restaurant: { id: user.restaurant.id, name: user.restaurant.name, slug: user.restaurant.slug },
        roles: [...user.roles].sort(),
        permissions: [...user.permissions].sort(),
      };

      return { sessionToken, identity };
    },
    getSession: async (token) => {
      if (!token) return null;
      const tokenHash = hashSessionToken(token.trim());
      const session = sessions.get(tokenHash);
      if (!session) return null;
      if (session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
        return null;
      }
      const user = Array.from(users.values()).find((u) => u.id === session.userId);
      if (!user || user.status !== "ACTIVE" || user.deletedAt !== null) return null;
      if (user.restaurant.status !== "ACTIVE" || user.restaurant.deletedAt !== null) return null;

      return {
        user: { id: user.id, name: user.name, email: user.email },
        restaurant: { id: user.restaurant.id, name: user.restaurant.name, slug: user.restaurant.slug },
        roles: [...user.roles].sort(),
        permissions: [...user.permissions].sort(),
      };
    },
    logout: async (token) => {
      if (!token) return;
      const tokenHash = hashSessionToken(token.trim());
      const session = sessions.get(tokenHash);
      if (session) {
        session.revokedAt = new Date();
      }
    },
  },
  tables: {
    list: async (restaurantId) => [...(tablesByRestaurant.get(restaurantId) ?? [])],
    create: async ({ restaurantId, actorUserId, tableNumber, capacity }) => {
      const normalized = typeof tableNumber === "string" ? tableNumber.trim().replace(/\s+/g, " ").toUpperCase() : "";
      if (!/^[A-Z0-9][A-Z0-9 -]{0,19}$/.test(normalized)) {
        throw new TableManagementError("Invalid table number.", "INVALID_INPUT");
      }
      const seats = capacity === undefined ? 4 : capacity;
      if (!Number.isInteger(seats) || (seats as number) < 1 || (seats as number) > 50) {
        throw new TableManagementError("Invalid capacity.", "INVALID_INPUT");
      }
      const rows = tablesByRestaurant.get(restaurantId) ?? [];
      if (rows.some((row) => row.tableNumber === normalized)) {
        throw new TableManagementError("A table with that number already exists.", "CONFLICT");
      }
      const table: RestaurantTableDto = {
        id: randomUUID(),
        tableNumber: normalized,
        capacity: seats as number,
        status: "AVAILABLE",
        createdAt: new Date().toISOString(),
      };
      rows.push(table);
      tablesByRestaurant.set(restaurantId, rows);
      // actorUserId is intentionally accepted only from the authenticated session handler.
      void actorUserId;
      return table;
    },
    updateStatus: async ({ restaurantId, actorUserId, tableId, status }) => {
      void actorUserId;
      const validStatuses = ["AVAILABLE", "OCCUPIED", "RESERVED", "BILLING", "CLEANING"];
      if (typeof status !== "string" || !validStatuses.includes(status)) {
        throw new TableManagementError("Invalid table status.", "INVALID_INPUT");
      }
      const rows = tablesByRestaurant.get(restaurantId) ?? [];
      const table = rows.find((t) => t.id === tableId);
      if (!table) {
        throw new TableManagementError("Table not found.", "NOT_FOUND");
      }
      table.status = status;
      return { ...table };
    },
  },
  menu: {
    listCategories: async (restaurantId) => [...(categoriesByRestaurant.get(restaurantId) ?? [])],
    createCategory: async ({ restaurantId, actorUserId, name, displayOrder }) => {
      const normalized = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
      if (!normalized || normalized.length > 80) {
        throw new MenuManagementError("Invalid category name.", "INVALID_INPUT");
      }
      const order = typeof displayOrder === "number" && Number.isInteger(displayOrder) && displayOrder >= 0 ? displayOrder : 0;
      const categories = categoriesByRestaurant.get(restaurantId) ?? [];
      if (categories.some((c) => c.name.toLowerCase() === normalized.toLowerCase())) {
        throw new MenuManagementError("A category with that name already exists.", "CONFLICT");
      }
      const category: MenuCategoryDto = {
        id: randomUUID(),
        name: normalized,
        displayOrder: order,
        isActive: true,
      };
      categories.push(category);
      categoriesByRestaurant.set(restaurantId, categories);
      void actorUserId;
      return category;
    },
    listItems: async (restaurantId) => [...(itemsByRestaurant.get(restaurantId) ?? [])],
    createItem: async ({ restaurantId, actorUserId, categoryId, name, price, description, diet, displayOrder }) => {
      const categories = categoriesByRestaurant.get(restaurantId) ?? [];
      const category = categories.find((c) => c.id === categoryId);
      if (!category) {
        throw new MenuManagementError("The specified category was not found.", "NOT_FOUND");
      }
      const normalizedName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
      if (!normalizedName || normalizedName.length > 120) {
        throw new MenuManagementError("Invalid dish name.", "INVALID_INPUT");
      }
      const numPrice = typeof price === "number" ? price : Number(price);
      if (Number.isNaN(numPrice) || numPrice <= 0 || numPrice > 100_000) {
        throw new MenuManagementError("Invalid price.", "INVALID_INPUT");
      }
      const validDiet = diet === "NON_VEG" || diet === "EGG" ? diet : "VEG";
      const order = typeof displayOrder === "number" && Number.isInteger(displayOrder) && displayOrder >= 0 ? displayOrder : 0;
      const items = itemsByRestaurant.get(restaurantId) ?? [];
      const item: MenuItemDto = {
        id: randomUUID(),
        categoryId: category.id,
        categoryName: category.name,
        name: normalizedName,
        description: typeof description === "string" ? description.trim() || null : null,
        diet: validDiet,
        price: Math.round(numPrice * 100) / 100,
        isAvailable: true,
        displayOrder: order,
        createdAt: new Date().toISOString(),
      };
      items.push(item);
      itemsByRestaurant.set(restaurantId, items);
      void actorUserId;
      return item;
    },
  },
  orders: {
    list: async (restaurantId) => [...(ordersByRestaurant.get(restaurantId) ?? [])],
    create: async ({ restaurantId, actorUserId, tableNumber, type, notes, items }) => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new OrderManagementError("Order must include at least one item.", "INVALID_INPUT");
      }
      const menuItems = itemsByRestaurant.get(restaurantId) ?? [];
      const itemCalculations = items.map((i) => {
        const found = menuItems.find((m) => m.id === i.menuItemId);
        if (!found) {
          throw new OrderManagementError("Menu item not found.", "INVALID_INPUT");
        }
        const qty = Number(i.quantity);
        if (!Number.isInteger(qty) || qty <= 0) {
          throw new OrderManagementError("Invalid quantity.", "INVALID_INPUT");
        }
        const lineTotal = Math.round(found.price * qty * 100) / 100;
        const lineTax = Math.round(lineTotal * 0.05 * 100) / 100;
        return {
          id: randomUUID(),
          menuItemId: found.id,
          itemName: found.name,
          quantity: qty,
          unitPrice: found.price,
          taxRate: 0.05,
          taxAmount: lineTax,
          total: lineTotal,
          instructions: i.instructions ?? null,
        };
      });

      const subtotal = itemCalculations.reduce((sum, item) => sum + item.total, 0);
      const taxTotal = itemCalculations.reduce((sum, item) => sum + item.taxAmount, 0);
      const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

      const orders = ordersByRestaurant.get(restaurantId) ?? [];
      const orderNumber = `ORD-${String(orders.length + 1).padStart(4, "0")}`;
      const kotNumber = `KOT-${String(orders.length + 1).padStart(4, "0")}`;

      const kotId = randomUUID();
      const kot: KotTicketDto = {
        id: kotId,
        kotNumber,
        status: "NEW",
        createdAt: new Date().toISOString(),
      };

      const rawTable = typeof tableNumber === "string" ? tableNumber.trim().toUpperCase() : null;

      const order: OrderDto = {
        id: randomUUID(),
        orderNumber,
        tableNumber: rawTable,
        type: type === "TAKEAWAY" ? "TAKEAWAY" : "DINE_IN",
        status: "PLACED",
        subtotal,
        taxTotal,
        grandTotal,
        notes: rawTable ? `Table: ${rawTable}` : (typeof notes === "string" ? notes.trim() : null),
        createdAt: new Date().toISOString(),
        items: itemCalculations,
        kots: [kot],
      };

      orders.unshift(order);
      ordersByRestaurant.set(restaurantId, orders);
      if (rawTable) {
        const tableRows = tablesByRestaurant.get(restaurantId) ?? [];
        const matched = tableRows.find((t) => t.tableNumber === rawTable);
        if (matched && matched.status === "AVAILABLE") {
          matched.status = "OCCUPIED";
        }
      }
      void actorUserId;
      return order;
    },
    updateKotStatus: async ({ restaurantId, actorUserId, kotId, status }) => {
      const validStatuses = ["NEW", "PREPARING", "READY", "SERVED", "CANCELLED"] as const;
      if (typeof status !== "string" || !validStatuses.includes(status as typeof validStatuses[number])) {
        throw new OrderManagementError("Invalid status.", "INVALID_INPUT");
      }
      const orders = ordersByRestaurant.get(restaurantId) ?? [];
      for (const order of orders) {
        const foundKot = order.kots.find((k) => k.id === kotId);
        if (foundKot) {
          foundKot.status = status as typeof validStatuses[number];
          void actorUserId;
          return { ...foundKot };
        }
      }
      throw new OrderManagementError("KOT ticket not found.", "NOT_FOUND");
    },
    settle: async ({ restaurantId, actorUserId, orderId, paymentMethod }) => {
      const validMethods = ["CASH", "UPI", "CARD"] as const;
      if (typeof paymentMethod !== "string" || !validMethods.includes(paymentMethod as typeof validMethods[number])) {
        throw new OrderManagementError("Invalid payment method.", "INVALID_INPUT");
      }
      const orders = ordersByRestaurant.get(restaurantId) ?? [];
      const found = orders.find((o) => o.id === orderId);
      if (!found) {
        throw new OrderManagementError("Order not found.", "NOT_FOUND");
      }
      found.status = "SETTLED";
      found.paymentMethod = paymentMethod as "CASH" | "UPI" | "CARD";
      for (const kot of found.kots) {
        if (kot.status !== "CANCELLED") kot.status = "SERVED";
      }
      void actorUserId;
      return { ...found };
    },
  },
  customers: {
    list: async (restaurantId) => customersByRestaurant.get(restaurantId) ?? [],
    create: async ({ restaurantId, actorUserId, name, phone, email, notes }) => {
      void actorUserId;
      if (typeof name !== "string" || !name.trim()) {
        throw new CustomerManagementError("Customer name must be text.", "INVALID_INPUT");
      }
      const existing = customersByRestaurant.get(restaurantId) ?? [];
      const customer: CustomerDto = {
        id: randomUUID(),
        name: name.trim(),
        phone: typeof phone === "string" ? phone.trim() : null,
        email: typeof email === "string" ? email.trim().toLowerCase() : null,
        notes: typeof notes === "string" ? notes.trim() : null,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
      };
      existing.unshift(customer);
      customersByRestaurant.set(restaurantId, existing);
      return customer;
    },
  },
  staff: {
    list: async (restaurantId) => {
      const customStaff = staffByRestaurant.get(restaurantId) ?? [];
      const seeded = Array.from(users.values())
        .filter((u) => u.restaurant.id === restaurantId && u.status === "ACTIVE")
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          phone: null,
          role: u.roles[0] || "Staff",
          status: u.status,
          createdAt: new Date().toISOString(),
        }));
      return [...seeded, ...customStaff];
    },
    create: async ({ restaurantId, actorUserId, name, email, role, phone }) => {
      void actorUserId;
      if (typeof name !== "string" || !name.trim()) {
        throw new StaffManagementError("Full name must be text.", "INVALID_INPUT");
      }
      if (typeof email !== "string" || !email.includes("@")) {
        throw new StaffManagementError("Please provide a valid email address.", "INVALID_INPUT");
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (users.has(normalizedEmail)) {
        throw new StaffManagementError("A team member with that email address already exists.", "CONFLICT");
      }
      const existingStaff = staffByRestaurant.get(restaurantId) ?? [];
      if (existingStaff.some((s) => s.email === normalizedEmail)) {
        throw new StaffManagementError("A team member with that email address already exists.", "CONFLICT");
      }
      const member: StaffMemberDto = {
        id: randomUUID(),
        name: name.trim(),
        email: normalizedEmail,
        phone: typeof phone === "string" ? phone.trim() : null,
        role: typeof role === "string" ? role.trim() : "Waiter",
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
      };
      existingStaff.unshift(member);
      staffByRestaurant.set(restaurantId, existingStaff);
      return member;
    },
  },
  public: {
    getMenu: async (slug) => {
      const user = Array.from(users.values()).find((u) => u.restaurant.slug === slug);
      if (!user || user.restaurant.status !== "ACTIVE") {
        throw new PublicOrderError("Restaurant not found.", "NOT_FOUND");
      }
      const restaurantId = user.restaurant.id;
      return {
        restaurant: {
          id: user.restaurant.id,
          name: user.restaurant.name,
          slug: user.restaurant.slug,
        },
        categories: [...(categoriesByRestaurant.get(restaurantId) ?? [])],
        items: [...(itemsByRestaurant.get(restaurantId) ?? [])],
      };
    },
    createOrder: async ({ slug, tableNumber, customerName, phone, notes, items }) => {
      void phone;
      const user = Array.from(users.values()).find((u) => u.restaurant.slug === slug);
      if (!user || user.restaurant.status !== "ACTIVE") {
        throw new PublicOrderError("Restaurant not found.", "NOT_FOUND");
      }
      const restaurantId = user.restaurant.id;
      if (!Array.isArray(items) || items.length === 0) {
        throw new PublicOrderError("Order must include at least one item.", "INVALID_INPUT");
      }
      const rawTable = typeof tableNumber === "string" ? tableNumber.trim().toUpperCase() : "";
      if (!rawTable) {
        throw new PublicOrderError("Table identifier is required.", "INVALID_INPUT");
      }
      const menuItems = itemsByRestaurant.get(restaurantId) ?? [];
      const itemCalculations = items.map((i) => {
        const found = menuItems.find((m) => m.id === i.menuItemId);
        if (!found) throw new PublicOrderError("Menu item not found.", "INVALID_INPUT");
        const qty = Number(i.quantity);
        if (!Number.isInteger(qty) || qty <= 0) throw new PublicOrderError("Invalid quantity.", "INVALID_INPUT");
        const lineTotal = Math.round(found.price * qty * 100) / 100;
        const lineTax = Math.round(lineTotal * 0.05 * 100) / 100;
        return {
          id: randomUUID(),
          menuItemId: found.id,
          itemName: found.name,
          quantity: qty,
          unitPrice: found.price,
          taxRate: 0.05,
          taxAmount: lineTax,
          total: lineTotal,
          instructions: i.instructions ?? null,
        };
      });
      const subtotal = itemCalculations.reduce((sum, item) => sum + item.total, 0);
      const taxTotal = itemCalculations.reduce((sum, item) => sum + item.taxAmount, 0);
      const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;
      const orders = ordersByRestaurant.get(restaurantId) ?? [];
      const orderNumber = `ORD-${String(orders.length + 1).padStart(4, "0")}`;
      const kotNumber = `KOT-${String(orders.length + 1).padStart(4, "0")}`;
      const kot: KotTicketDto = {
        id: randomUUID(),
        kotNumber,
        status: "NEW",
        createdAt: new Date().toISOString(),
      };
      const guestLabel = customerName ? `Guest: ${customerName} · Table: ${rawTable}` : `Table: ${rawTable}`;
      const orderNotes = notes ? `${guestLabel} (${notes})` : guestLabel;
      const order: OrderDto = {
        id: randomUUID(),
        orderNumber,
        tableNumber: rawTable,
        type: "DINE_IN",
        status: "PLACED",
        subtotal,
        taxTotal,
        grandTotal,
        notes: orderNotes,
        createdAt: new Date().toISOString(),
        items: itemCalculations,
        kots: [kot],
      };
      orders.unshift(order);
      ordersByRestaurant.set(restaurantId, orders);
      if (rawTable) {
        const tableRows = tablesByRestaurant.get(restaurantId) ?? [];
        const matched = tableRows.find((t) => t.tableNumber === rawTable);
        if (matched && matched.status === "AVAILABLE") {
          matched.status = "OCCUPIED";
        }
      }
      return order;
    },
    getOrderStatus: async (slug, orderNumber) => {
      const user = Array.from(users.values()).find((u) => u.restaurant.slug === slug);
      if (!user) return null;
      const orders = ordersByRestaurant.get(user.restaurant.id) ?? [];
      const found = orders.find((o) => o.orderNumber === orderNumber);
      return found ? { ...found } : null;
    },
  },
});

const port = Number(process.env.PORT ?? 4317);
await app.listen({ host: "127.0.0.1", port });
