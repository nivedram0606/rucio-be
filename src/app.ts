import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { createHash, timingSafeEqual } from "node:crypto";
import { createRestaurantWithAdmin, OnboardingError, type CreateRestaurantInput } from "./onboarding/create-restaurant";
import type { OnboardedRestaurant } from "./onboarding/create-restaurant";
import {
  authenticateWithPassword,
  validateSessionToken,
  revokeSessionToken,
  AuthError,
  type AuthIdentity,
} from "./auth/auth-service";
import {
  parseCookies,
  serializeSessionCookie,
  serializeClearSessionCookie,
  isAllowedOrigin,
  SESSION_COOKIE_NAME,
} from "./auth/cookies";
import {
  createRestaurantTable,
  listRestaurantTables,
  updateRestaurantTableStatus,
  TableManagementError,
  type RestaurantTableDto,
} from "./tables/table-service";
import {
  createMenuCategory,
  createMenuItem,
  listMenuCategories,
  listMenuItems,
  MenuManagementError,
  type MenuCategoryDto,
  type MenuItemDto,
} from "./menu/menu-service";
import {
  createOrder,
  listOrders,
  OrderManagementError,
  updateKotStatus,
  settleOrder,
  type CreateOrderInput,
  type KotTicketDto,
  type OrderDto,
  type OrderItemDto,
} from "./orders/order-service";
import {
  createCustomer,
  listCustomers,
  CustomerManagementError,
  type CustomerDto,
} from "./customers/customer-service";
import {
  createRestaurantStaff,
  listRestaurantStaff,
  StaffManagementError,
  type StaffMemberDto,
} from "./staff/staff-service";
import {
  getPublicMenuBySlug,
  createPublicOrder,
  getPublicOrderStatus,
  PublicOrderError,
  type PublicMenuDto,
} from "./public/public-service";

export type AuthHandlers = {
  login: (email: string, password: string) => Promise<{ sessionToken: string; identity: AuthIdentity }>;
  getSession: (sessionToken: string) => Promise<AuthIdentity | null>;
  logout: (sessionToken: string) => Promise<void>;
};

export type TableHandlers = {
  list: (restaurantId: string) => Promise<RestaurantTableDto[]>;
  create: (input: { restaurantId: string; actorUserId: string; tableNumber: unknown; capacity?: unknown }) => Promise<RestaurantTableDto>;
  updateStatus: (input: { restaurantId: string; actorUserId: string; tableId: string; status: unknown }) => Promise<RestaurantTableDto>;
};

export type MenuHandlers = {
  listCategories: (restaurantId: string) => Promise<MenuCategoryDto[]>;
  createCategory: (input: { restaurantId: string; actorUserId: string; name: unknown; displayOrder?: unknown }) => Promise<MenuCategoryDto>;
  listItems: (restaurantId: string) => Promise<MenuItemDto[]>;
  createItem: (input: { restaurantId: string; actorUserId: string; categoryId: unknown; name: unknown; price: unknown; description?: unknown; diet?: unknown; displayOrder?: unknown }) => Promise<MenuItemDto>;
};

export type OrderHandlers = {
  list: (restaurantId: string) => Promise<OrderDto[]>;
  create: (input: CreateOrderInput) => Promise<OrderDto>;
  updateKotStatus: (input: { restaurantId: string; actorUserId: string; kotId: string; status: unknown }) => Promise<KotTicketDto>;
  settle: (input: { restaurantId: string; actorUserId: string; orderId: string; paymentMethod: unknown }) => Promise<OrderDto>;
};

export type CustomerHandlers = {
  list: (restaurantId: string) => Promise<CustomerDto[]>;
  create: (input: { restaurantId: string; actorUserId: string; name: unknown; phone?: unknown; email?: unknown; notes?: unknown }) => Promise<CustomerDto>;
};

export type StaffHandlers = {
  list: (restaurantId: string) => Promise<StaffMemberDto[]>;
  create: (input: { restaurantId: string; actorUserId: string; name: unknown; email: unknown; role: unknown; phone?: unknown }) => Promise<StaffMemberDto>;
};

export type PublicHandlers = {
  getMenu: (slug: string) => Promise<PublicMenuDto>;
  createOrder: (input: { slug: string; tableNumber: string; customerName?: string; phone?: string; notes?: string; items: unknown }) => Promise<OrderDto>;
  getOrderStatus: (slug: string, orderNumber: string) => Promise<OrderDto | null>;
};

export type AppOptions = {
  onboardingKey?: string;
  onboard?: (input: CreateRestaurantInput) => Promise<OnboardedRestaurant>;
  auth?: Partial<AuthHandlers>;
  tables?: Partial<TableHandlers>;
  menu?: Partial<MenuHandlers>;
  orders?: Partial<OrderHandlers>;
  customers?: Partial<CustomerHandlers>;
  staff?: Partial<StaffHandlers>;
  public?: Partial<PublicHandlers>;
  logger?: boolean;
};

const errorResponse = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
} as const;

const authIdentityResponse = {
  type: "object",
  additionalProperties: false,
  required: ["user", "restaurant", "roles", "permissions"],
  properties: {
    user: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "email"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
      },
    },
    restaurant: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "slug"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        slug: { type: "string" },
      },
    },
    roles: { type: "array", items: { type: "string" } },
    permissions: { type: "array", items: { type: "string" } },
  },
} as const;

const restaurantTableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "tableNumber", "capacity", "status", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    tableNumber: { type: "string" },
    capacity: { type: "integer" },
    status: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const tableBody = {
  type: "object",
  additionalProperties: false,
  required: ["tableNumber"],
  properties: {
    tableNumber: { type: "string", minLength: 1, maxLength: 40, description: "Trimmed and normalized to uppercase; 1–20 letters, numbers, spaces, or hyphens, starting with a letter or number." },
    capacity: { type: "integer", minimum: 1, maximum: 50, default: 4 },
  },
} as const;

const updateTableStatusBody = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["AVAILABLE", "OCCUPIED", "RESERVED", "BILLING", "CLEANING"],
    },
  },
} as const;

const menuCategorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "displayOrder", "isActive"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    displayOrder: { type: "integer" },
    isActive: { type: "boolean" },
  },
} as const;

const menuItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "categoryId", "categoryName", "name", "diet", "price", "isAvailable", "displayOrder", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    categoryId: { type: "string", format: "uuid" },
    categoryName: { type: "string" },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    diet: { type: "string", enum: ["VEG", "NON_VEG", "EGG"] },
    price: { type: "number" },
    isAvailable: { type: "boolean" },
    displayOrder: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const categoryBody = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80, description: "Category name, 1–80 characters." },
    displayOrder: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

const menuItemBody = {
  type: "object",
  additionalProperties: false,
  required: ["categoryId", "name", "price"],
  properties: {
    categoryId: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 120, description: "Dish name, 1–120 characters." },
    price: { type: "number", minimum: 0.01, maximum: 100000, description: "Price in restaurant currency." },
    diet: { type: "string", enum: ["VEG", "NON_VEG", "EGG"], default: "VEG" },
    description: { type: "string", maxLength: 500 },
    displayOrder: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

const orderItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "menuItemId", "itemName", "quantity", "unitPrice", "taxRate", "taxAmount", "total", "instructions"],
  properties: {
    id: { type: "string" },
    menuItemId: { type: "string" },
    itemName: { type: "string" },
    quantity: { type: "integer" },
    unitPrice: { type: "number" },
    taxRate: { type: "number" },
    taxAmount: { type: "number" },
    total: { type: "number" },
    instructions: { type: ["string", "null"] },
  },
} as const;

const kotTicketSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kotNumber", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    kotNumber: { type: "string" },
    status: { type: "string", enum: ["NEW", "PREPARING", "READY", "SERVED", "CANCELLED"] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const orderSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "orderNumber", "tableNumber", "type", "status", "subtotal", "taxTotal", "grandTotal", "notes", "createdAt", "items", "kots"],
  properties: {
    id: { type: "string" },
    orderNumber: { type: "string" },
    tableNumber: { type: ["string", "null"] },
    type: { type: "string", enum: ["DINE_IN", "TAKEAWAY"] },
    status: { type: "string" },
    paymentMethod: { type: ["string", "null"] },
    subtotal: { type: "number" },
    taxTotal: { type: "number" },
    grandTotal: { type: "number" },
    notes: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    items: { type: "array", items: orderItemSchema },
    kots: { type: "array", items: kotTicketSchema },
  },
} as const;

const createOrderBody = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    tableNumber: { type: "string", maxLength: 20 },
    type: { type: "string", enum: ["DINE_IN", "TAKEAWAY"], default: "DINE_IN" },
    notes: { type: "string", maxLength: 500 },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["menuItemId", "quantity"],
        properties: {
          menuItemId: { type: "string", minLength: 1 },
          quantity: { type: "integer", minimum: 1, maximum: 100 },
          instructions: { type: "string", maxLength: 200 },
        },
      },
    },
  },
} as const;

const updateKotStatusBody = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["NEW", "PREPARING", "READY", "SERVED", "CANCELLED"] },
  },
} as const;

const loginBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 1024, writeOnly: true },
  },
} as const;

const onboardingBody = {
  type: "object",
  additionalProperties: false,
  required: ["restaurantName", "ownerName", "ownerEmail", "ownerPassword"],
  properties: {
    restaurantName: { type: "string", minLength: 1, maxLength: 120 },
    restaurantSlug: {
      type: "string",
      description: "Workspace URL. Uppercase letters are accepted and normalized to lowercase.",
      minLength: 3,
      maxLength: 63,
      pattern: "^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$",
    },
    ownerName: { type: "string", minLength: 1, maxLength: 120 },
    ownerEmail: { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
    ownerPhone: { type: "string", maxLength: 32 },
    ownerPassword: { type: "string", minLength: 12, maxLength: 1024, writeOnly: true },
  },
} as const;

const settleOrderBody = {
  type: "object",
  additionalProperties: false,
  required: ["paymentMethod"],
  properties: {
    paymentMethod: { type: "string", enum: ["CASH", "UPI", "CARD"] },
  },
} as const;

const publicMenuResponse = {
  type: "object",
  additionalProperties: false,
  required: ["restaurant", "categories", "items"],
  properties: {
    restaurant: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "slug"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
      },
    },
    categories: { type: "array", items: menuCategorySchema },
    items: { type: "array", items: menuItemSchema },
  },
} as const;

const createPublicOrderBody = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "tableNumber", "items"],
  properties: {
    slug: { type: "string", minLength: 1, maxLength: 63 },
    tableNumber: { type: "string", minLength: 1, maxLength: 20 },
    customerName: { type: "string", maxLength: 100 },
    phone: { type: "string", maxLength: 30 },
    notes: { type: "string", maxLength: 500 },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["menuItemId", "quantity"],
        properties: {
          menuItemId: { type: "string", minLength: 1 },
          quantity: { type: "integer", minimum: 1, maximum: 100 },
          instructions: { type: "string", maxLength: 200 },
        },
      },
    },
  },
} as const;

function secureKeyMatches(candidate: string | string[] | undefined, expected: string | undefined): boolean {
  if (!expected || typeof candidate !== "string") return false;
  const provided = createHash("sha256").update(candidate, "utf8").digest();
  const configured = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(provided, configured);
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const onboardingKey = options.onboardingKey ?? process.env.ONBOARDING_API_KEY;
  if (onboardingKey && Buffer.byteLength(onboardingKey, "utf8") < 32) {
    throw new Error("ONBOARDING_API_KEY must be at least 32 bytes.");
  }
  const onboard = options.onboard ?? createRestaurantWithAdmin;
  const auth: AuthHandlers = {
    login: options.auth?.login ?? authenticateWithPassword,
    getSession: options.auth?.getSession ?? validateSessionToken,
    logout: options.auth?.logout ?? revokeSessionToken,
  };
  const tables: TableHandlers = {
    list: options.tables?.list ?? listRestaurantTables,
    create: options.tables?.create ?? createRestaurantTable,
    updateStatus: options.tables?.updateStatus ?? updateRestaurantTableStatus,
  };
  const menu: MenuHandlers = {
    listCategories: options.menu?.listCategories ?? listMenuCategories,
    createCategory: options.menu?.createCategory ?? createMenuCategory,
    listItems: options.menu?.listItems ?? listMenuItems,
    createItem: options.menu?.createItem ?? createMenuItem,
  };
  const orders: OrderHandlers = {
    list: options.orders?.list ?? listOrders,
    create: options.orders?.create ?? createOrder,
    updateKotStatus: options.orders?.updateKotStatus ?? updateKotStatus,
    settle: options.orders?.settle ?? settleOrder,
  };
  const customers: CustomerHandlers = {
    list: options.customers?.list ?? listCustomers,
    create: options.customers?.create ?? createCustomer,
  };
  const staff: StaffHandlers = {
    list: options.staff?.list ?? listRestaurantStaff,
    create: options.staff?.create ?? createRestaurantStaff,
  };
  const publicMenu: PublicHandlers = {
    getMenu: options.public?.getMenu ?? getPublicMenuBySlug,
    createOrder: options.public?.createOrder ?? createPublicOrder,
    getOrderStatus: options.public?.getOrderStatus ?? getPublicOrderStatus,
  };

  // Reject mismatched JSON types instead of coercing numbers/booleans into strings.
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { coerceTypes: false } } });

  app.setErrorHandler((error, request, reply) => {
    const isValidationError = typeof error === "object" && error !== null && "validation" in error;
    const requestContentType = request.headers["content-type"];
    const hasUnsupportedContentType = typeof requestContentType === "string"
      && !/^application\/json(?:\s*;|$)/i.test(requestContentType);
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
    if (isValidationError || statusCode < 500) {
      const responseStatus = hasUnsupportedContentType ? 415 : isValidationError ? 400 : statusCode;
      const code = responseStatus === 413 ? "PAYLOAD_TOO_LARGE" : responseStatus === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST";
      const message = responseStatus === 413 ? "Request payload is too large." : responseStatus === 415 ? "Content type is not supported." : "Request validation failed.";
      return reply.code(responseStatus).send({ code, message });
    }
    request.log.error(error);
    return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
  });

  async function identityForPermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: string,
  ): Promise<AuthIdentity | null> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "Sign in to continue." });
      return null;
    }
    try {
      const identity = await auth.getSession(token);
      if (!identity) {
        reply.code(401).send({ code: "UNAUTHENTICATED", message: "Session expired or invalid." });
        return null;
      }
      if (!identity.permissions.includes(permission)) {
        reply.code(403).send({ code: "FORBIDDEN", message: "You do not have permission to perform this action." });
        return null;
      }
      return identity;
    } catch (error) {
      request.log.error(error);
      reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      return null;
    }
  }

  async function identityForAnyPermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permissions: string[],
  ): Promise<AuthIdentity | null> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "Sign in to continue." });
      return null;
    }
    try {
      const identity = await auth.getSession(token);
      if (!identity) {
        reply.code(401).send({ code: "UNAUTHENTICATED", message: "Session expired or invalid." });
        return null;
      }
      if (!permissions.some((p) => identity.permissions.includes(p))) {
        reply.code(403).send({ code: "FORBIDDEN", message: "You do not have permission to perform this action." });
        return null;
      }
      return identity;
    } catch (error) {
      request.log.error(error);
      reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      return null;
    }
  }

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Restaurant OS API",
        description: "Restaurant provisioning, authentication, and backend health endpoints.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          OnboardingKey: {
            type: "apiKey",
            in: "header",
            name: "x-onboarding-key",
            description: "Internal provisioning key. This endpoint is not public self-service signup.",
          },
          SessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: SESSION_COOKIE_NAME,
            description: "Opaque session token stored in an HttpOnly, SameSite=Strict cookie.",
          },
        },
      },
    },
  });

  app.get(
    "/api/health",
    {
      schema: {
        tags: ["System"],
        operationId: "getHealth",
        summary: "Check API health",
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { type: "string", const: "ok" } },
          },
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    {
      schema: {
        tags: ["Auth"],
        operationId: "login",
        summary: "Sign in with admin credentials",
        description:
          "Authenticates a restaurant Admin or staff member and sets an HttpOnly SameSite=Strict session cookie.",
        body: loginBody,
        response: {
          200: authIdentityResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          413: errorResponse,
          415: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }

      try {
        const result = await auth.login(request.body.email, request.body.password);
        const isProduction = process.env.NODE_ENV === "production";
        reply.header("Set-Cookie", serializeSessionCookie(result.sessionToken, { isProduction }));
        return reply.code(200).send(result.identity);
      } catch (error) {
        if (error instanceof AuthError && error.code === "INVALID_CREDENTIALS") {
          return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "Invalid email or password." });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.get(
    "/api/auth/session",
    {
      schema: {
        tags: ["Auth"],
        operationId: "getSession",
        summary: "Get current authenticated session",
        description:
          "Derives tenant and user identity strictly from the authenticated session cookie. Client-supplied tenant IDs are never trusted.",
        security: [{ SessionCookie: [] }],
        response: {
          200: authIdentityResponse,
          401: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const cookies = parseCookies(request.headers.cookie);
      const token = cookies[SESSION_COOKIE_NAME];
      if (!token) {
        return reply.code(401).send({ code: "UNAUTHENTICATED", message: "No active session." });
      }

      try {
        const identity = await auth.getSession(token);
        if (!identity) {
          const isProduction = process.env.NODE_ENV === "production";
          reply.header("Set-Cookie", serializeClearSessionCookie({ isProduction }));
          return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Session expired or invalid." });
        }
        return reply.code(200).send(identity);
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post(
    "/api/auth/logout",
    {
      schema: {
        tags: ["Auth"],
        operationId: "logout",
        summary: "End the current session",
        description: "Revokes the active session token in the database and clears the browser session cookie.",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["success"],
            properties: { success: { type: "boolean", const: true } },
          },
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }

      const cookies = parseCookies(request.headers.cookie);
      const token = cookies[SESSION_COOKIE_NAME];
      const isProduction = process.env.NODE_ENV === "production";
      reply.header("Set-Cookie", serializeClearSessionCookie({ isProduction }));

      if (token) {
        try {
          await auth.logout(token);
        } catch (error) {
          request.log.error(error);
        }
      }

      return reply.code(200).send({ success: true });
    },
  );

  app.get(
    "/api/tables",
    {
      schema: {
        tags: ["Tables"],
        operationId: "listRestaurantTables",
        summary: "List tables in the authenticated restaurant",
        description: "Tenant scope comes only from the verified session. Requires tables.view.",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tables"],
            properties: { tables: { type: "array", items: restaurantTableSchema } },
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await identityForPermission(request, reply, "tables.view");
      if (!identity) return reply;
      try {
        return reply.code(200).send({ tables: await tables.list(identity.restaurant.id) });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { tableNumber: string; capacity?: number } }>(
    "/api/tables",
    {
      schema: {
        tags: ["Tables"],
        operationId: "createRestaurantTable",
        summary: "Add a table to the authenticated restaurant",
        description: "Tenant and audit actor are derived from the verified session. Requires tables.create.",
        security: [{ SessionCookie: [] }],
        body: tableBody,
        response: {
          201: restaurantTableSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          413: errorResponse,
          415: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "tables.create");
      if (!identity) return reply;
      try {
        const table = await tables.create({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          tableNumber: request.body.tableNumber,
          capacity: request.body.capacity,
        });
        return reply.code(201).send(table);
      } catch (error) {
        if (error instanceof TableManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : 409;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    "/api/tables/:id/status",
    {
      schema: {
        tags: ["Tables"],
        operationId: "updateRestaurantTableStatus",
        summary: "Update dining table status",
        description: "Updates table occupancy and seating status. Requires tables.create, tables.update, or tables.view.",
        security: [{ SessionCookie: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: updateTableStatusBody,
        response: {
          200: restaurantTableSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForAnyPermission(request, reply, ["tables.create", "tables.update", "tables.view"]);
      if (!identity) return reply;
      try {
        const table = await tables.updateStatus({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          tableId: request.params.id,
          status: request.body.status,
        });
        return reply.code(200).send(table);
      } catch (error) {
        if (error instanceof TableManagementError) {
          const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID_INPUT" ? 400 : 409;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.get(
    "/api/menu/categories",
    {
      schema: {
        tags: ["Menu"],
        operationId: "listMenuCategories",
        summary: "List menu categories in the authenticated restaurant",
        description: "Tenant scope comes only from the verified session. Requires menu.view.",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["categories"],
            properties: { categories: { type: "array", items: menuCategorySchema } },
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await identityForPermission(request, reply, "menu.view");
      if (!identity) return reply;
      try {
        return reply.code(200).send({ categories: await menu.listCategories(identity.restaurant.id) });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { name: string; displayOrder?: number } }>(
    "/api/menu/categories",
    {
      schema: {
        tags: ["Menu"],
        operationId: "createMenuCategory",
        summary: "Add a menu category to the authenticated restaurant",
        description: "Tenant and audit actor are derived from the verified session. Requires menu.create.",
        security: [{ SessionCookie: [] }],
        body: categoryBody,
        response: {
          201: menuCategorySchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          413: errorResponse,
          415: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "menu.create");
      if (!identity) return reply;
      try {
        const category = await menu.createCategory({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          name: request.body.name,
          displayOrder: request.body.displayOrder,
        });
        return reply.code(201).send(category);
      } catch (error) {
        if (error instanceof MenuManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "CONFLICT" ? 409 : 404;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.get(
    "/api/menu/items",
    {
      schema: {
        tags: ["Menu"],
        operationId: "listMenuItems",
        summary: "List menu items in the authenticated restaurant",
        description: "Tenant scope comes only from the verified session. Requires menu.view.",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: { items: { type: "array", items: menuItemSchema } },
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await identityForPermission(request, reply, "menu.view");
      if (!identity) return reply;
      try {
        return reply.code(200).send({ items: await menu.listItems(identity.restaurant.id) });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { categoryId: string; name: string; price: number; description?: string; diet?: "VEG" | "NON_VEG" | "EGG"; displayOrder?: number } }>(
    "/api/menu/items",
    {
      schema: {
        tags: ["Menu"],
        operationId: "createMenuItem",
        summary: "Add a menu item to the authenticated restaurant",
        description: "Tenant and audit actor are derived from the verified session. Requires menu.create.",
        security: [{ SessionCookie: [] }],
        body: menuItemBody,
        response: {
          201: menuItemSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          413: errorResponse,
          415: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "menu.create");
      if (!identity) return reply;
      try {
        const item = await menu.createItem({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          categoryId: request.body.categoryId,
          name: request.body.name,
          price: request.body.price,
          description: request.body.description,
          diet: request.body.diet,
          displayOrder: request.body.displayOrder,
        });
        return reply.code(201).send(item);
      } catch (error) {
        if (error instanceof MenuManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "CONFLICT" ? 409 : 404;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.get(
    "/api/orders",
    {
      schema: {
        tags: ["Orders"],
        operationId: "listOrders",
        summary: "List orders in the authenticated restaurant",
        description: "Tenant scope comes only from the verified session. Requires orders.view.",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["orders"],
            properties: { orders: { type: "array", items: orderSchema } },
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await identityForPermission(request, reply, "orders.view");
      if (!identity) return reply;
      try {
        return reply.code(200).send({ orders: await orders.list(identity.restaurant.id) });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { tableNumber?: string; type?: "DINE_IN" | "TAKEAWAY"; notes?: string; items: { menuItemId: string; quantity: number; instructions?: string }[] } }>(
    "/api/orders",
    {
      schema: {
        tags: ["Orders"],
        operationId: "createOrder",
        summary: "Create a dining room or takeaway order",
        description: "Tenant and actor derived from verified session. Requires orders.create.",
        security: [{ SessionCookie: [] }],
        body: createOrderBody,
        response: {
          201: orderSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          413: errorResponse,
          415: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "orders.create");
      if (!identity) return reply;
      try {
        const order = await orders.create({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          tableNumber: request.body.tableNumber,
          type: request.body.type,
          notes: request.body.notes,
          items: request.body.items,
        });
        return reply.code(201).send(order);
      } catch (error) {
        if (error instanceof OrderManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : 403;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: "NEW" | "PREPARING" | "READY" | "SERVED" | "CANCELLED" } }>(
    "/api/orders/kots/:id/status",
    {
      schema: {
        tags: ["Orders"],
        operationId: "updateKotStatus",
        summary: "Update the lifecycle status of a KOT ticket",
        description: "Tenant scope comes only from the verified session. Requires kot.update_status.",
        security: [{ SessionCookie: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: updateKotStatusBody,
        response: {
          200: kotTicketSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          413: errorResponse,
          415: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "kot.update_status");
      if (!identity) return reply;
      try {
        const kot = await orders.updateKotStatus({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          kotId: request.params.id,
          status: request.body.status,
        });
        return reply.code(200).send(kot);
      } catch (error) {
        if (error instanceof OrderManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : 403;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { paymentMethod: "CASH" | "UPI" | "CARD" } }>(
    "/api/orders/:id/settle",
    {
      schema: {
        tags: ["Orders"],
        operationId: "settleOrder",
        summary: "Settle an order and record payment",
        description: "Marks an order SETTLED and records payment method at counter. Requires orders.create.",
        security: [{ SessionCookie: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: settleOrderBody,
        response: {
          200: orderSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "orders.create");
      if (!identity) return reply;
      try {
        const settled = await orders.settle({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          orderId: request.params.id,
          paymentMethod: request.body.paymentMethod,
        });
        return reply.code(200).send(settled);
      } catch (error) {
        if (error instanceof OrderManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : 403;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  // ───────────── Customers Endpoints ─────────────
  app.get(
    "/api/customers",
    {
      schema: {
        tags: ["Customers"],
        operationId: "listCustomers",
        summary: "List customers for the authenticated restaurant",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["customers"],
            properties: {
              customers: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "name", "status", "createdAt"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    phone: { type: "string", nullable: true },
                    email: { type: "string", nullable: true },
                    notes: { type: "string", nullable: true },
                    status: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await identityForPermission(request, reply, "customers.view");
      if (!identity) return reply;
      try {
        return reply.code(200).send({ customers: await customers.list(identity.restaurant.id) });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { name: string; phone?: string; email?: string; notes?: string } }>(
    "/api/customers",
    {
      schema: {
        tags: ["Customers"],
        operationId: "createCustomer",
        summary: "Add a customer profile to the authenticated restaurant",
        security: [{ SessionCookie: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            phone: { type: "string", maxLength: 30 },
            email: { type: "string", format: "email", maxLength: 255 },
            notes: { type: "string", maxLength: 500 },
          },
        },
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "status", "createdAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              phone: { type: "string", nullable: true },
              email: { type: "string", nullable: true },
              notes: { type: "string", nullable: true },
              status: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "customers.create");
      if (!identity) return reply;
      try {
        const created = await customers.create({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          name: request.body.name,
          phone: request.body.phone,
          email: request.body.email,
          notes: request.body.notes,
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (error instanceof CustomerManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : 409;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  // ───────────── Staff Endpoints ─────────────
  app.get(
    "/api/staff",
    {
      schema: {
        tags: ["Staff"],
        operationId: "listStaff",
        summary: "List team members for the authenticated restaurant",
        security: [{ SessionCookie: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["staff"],
            properties: {
              staff: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "name", "email", "role", "status", "createdAt"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    email: { type: "string", format: "email" },
                    phone: { type: "string", nullable: true },
                    role: { type: "string" },
                    status: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await identityForPermission(request, reply, "users.view");
      if (!identity) return reply;
      try {
        return reply.code(200).send({ staff: await staff.list(identity.restaurant.id) });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { name: string; email: string; role: string; phone?: string } }>(
    "/api/staff",
    {
      schema: {
        tags: ["Staff"],
        operationId: "createStaff",
        summary: "Add a team member to the authenticated restaurant",
        security: [{ SessionCookie: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "email", "role"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            email: { type: "string", format: "email", maxLength: 255 },
            role: { type: "string", minLength: 1, maxLength: 50 },
            phone: { type: "string", maxLength: 30 },
          },
        },
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "email", "role", "status", "createdAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              email: { type: "string", format: "email" },
              phone: { type: "string", nullable: true },
              role: { type: "string" },
              status: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"])) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "Cross-origin request rejected." });
      }
      const identity = await identityForPermission(request, reply, "users.create");
      if (!identity) return reply;
      try {
        const created = await staff.create({
          restaurantId: identity.restaurant.id,
          actorUserId: identity.user.id,
          name: request.body.name,
          email: request.body.email,
          role: request.body.role,
          phone: request.body.phone,
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (error instanceof StaffManagementError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : 409;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  // ───────────── Public Customer QR Endpoints ─────────────
  app.get<{ Params: { slug: string } }>(
    "/api/public/menu/:slug",
    {
      schema: {
        tags: ["Public"],
        operationId: "getPublicMenu",
        summary: "Get dining menu for public customer QR ordering",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["slug"],
          properties: { slug: { type: "string" } },
        },
        response: {
          200: publicMenuResponse,
          400: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const menuData = await publicMenu.getMenu(request.params.slug);
        return reply.code(200).send(menuData);
      } catch (error) {
        if (error instanceof PublicOrderError) {
          const status = error.code === "NOT_FOUND" ? 404 : 400;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: { slug: string; tableNumber: string; customerName?: string; phone?: string; notes?: string; items: { menuItemId: string; quantity: number; instructions?: string }[] } }>(
    "/api/public/orders",
    {
      schema: {
        tags: ["Public"],
        operationId: "createPublicOrder",
        summary: "Place dining order from customer mobile QR",
        body: createPublicOrderBody,
        response: {
          201: orderSchema,
          400: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const created = await publicMenu.createOrder(request.body);
        return reply.code(201).send(created);
      } catch (error) {
        if (error instanceof PublicOrderError) {
          const status = error.code === "NOT_FOUND" ? 404 : 400;
          return reply.code(status).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.get<{ Params: { orderNumber: string }; Querystring: { slug: string } }>(
    "/api/public/orders/:orderNumber",
    {
      schema: {
        tags: ["Public"],
        operationId: "getPublicOrderStatus",
        summary: "Get order tracking and status for guest",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["orderNumber"],
          properties: { orderNumber: { type: "string" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["slug"],
          properties: { slug: { type: "string" } },
        },
        response: {
          200: orderSchema,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const order = await publicMenu.getOrderStatus(request.query.slug, request.params.orderNumber);
        if (!order) {
          return reply.code(404).send({ code: "NOT_FOUND", message: "Order not found." });
        }
        return reply.code(200).send(order);
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  app.post<{ Body: CreateRestaurantInput; Reply: OnboardedRestaurant | { code: string; message: string } }>(
    "/api/onboarding",
    {
      schema: {
        tags: ["Onboarding"],
        operationId: "createRestaurantWithAdmin",
        summary: "Provision a restaurant and its first Admin",
        description:
          "Internal bootstrap endpoint. Only call after verifying the Admin email out of band. Public self-service signup is not enabled.",
        security: [{ OnboardingKey: [] }],
        body: onboardingBody,
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: ["restaurant", "admin", "roles"],
            properties: {
              restaurant: {
                type: "object",
                additionalProperties: false,
                required: ["id", "name", "slug"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  slug: { type: "string" },
                },
              },
              admin: {
                type: "object",
                additionalProperties: false,
                required: ["id", "name", "email"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                },
              },
              roles: { type: "array", items: { type: "string" } },
            },
          },
          400: errorResponse,
          401: errorResponse,
          409: errorResponse,
          413: errorResponse,
          415: errorResponse,
          503: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!onboardingKey) {
        return reply.code(503).send({ code: "ONBOARDING_DISABLED", message: "Internal onboarding is not configured." });
      }
      if (!secureKeyMatches(request.headers["x-onboarding-key"], onboardingKey)) {
        return reply.code(401).send({ code: "UNAUTHORIZED", message: "A valid onboarding key is required." });
      }

      try {
        const result = await onboard(request.body);
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof OnboardingError) {
          const statusCode = error.code === "INVALID_INPUT" ? 400 : error.code === "CONFLICT" ? 409 : 503;
          return reply.code(statusCode).send({ code: error.code, message: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
    },
  );

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true,
  });

  return app;
}
