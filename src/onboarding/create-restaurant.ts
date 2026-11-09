import { ALL_KEYS, DEFAULT_ROLES } from "../../prisma/seed-permissions";
import { getPrismaClient } from "../db/client";
import { hashPassword, PasswordPolicyError } from "../auth/password";

export type CreateRestaurantInput = {
  restaurantName: string;
  restaurantSlug?: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string;
  ownerPassword: string;
};

export type OnboardedRestaurant = {
  restaurant: { id: string; name: string; slug: string };
  admin: { id: string; name: string; email: string };
  roles: string[];
};

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "CONFLICT" | "CONFIGURATION",
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new OnboardingError(`${field} is required and must be text.`, "INVALID_INPUT");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new OnboardingError(`${field} is required and must be at most ${maxLength} characters.`, "INVALID_INPUT");
  }
  return trimmed;
}

function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "");
}

function assertDefaultRolesAreValid(): void {
  const knownKeys = new Set(ALL_KEYS);
  const invalid = Object.entries(DEFAULT_ROLES).flatMap(([role, keys]) =>
    keys.filter((key) => !knownKeys.has(key)).map((key) => `${role}: ${key}`),
  );
  if (invalid.length) {
    throw new OnboardingError(`Default roles reference unknown permissions: ${invalid.join(", ")}`, "CONFIGURATION");
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/**
 * Atomically provisions one restaurant, its default settings and system roles,
 * and the first user assigned to the Admin role. Callers should only invoke
 * this after any required email-ownership verification has succeeded.
 */
export async function createRestaurantWithAdmin(input: CreateRestaurantInput): Promise<OnboardedRestaurant> {
  if (typeof input !== "object" || input === null) {
    throw new OnboardingError("Input must be a valid request object.", "INVALID_INPUT");
  }

  assertDefaultRolesAreValid();

  const restaurantName = requiredText(input.restaurantName, "Restaurant name", 120);
  const ownerName = requiredText(input.ownerName, "Admin name", 120);
  const ownerEmail = requiredText(input.ownerEmail, "Admin email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new OnboardingError("Enter a valid email address.", "INVALID_INPUT");
  }

  let restaurantSlug: string;
  if (input.restaurantSlug !== undefined) {
    if (typeof input.restaurantSlug !== "string") {
      throw new OnboardingError("Restaurant URL must be text.", "INVALID_INPUT");
    }
    restaurantSlug = requiredText(input.restaurantSlug, "Restaurant URL", 63).toLowerCase();
  } else {
    restaurantSlug = slugFromName(restaurantName);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(restaurantSlug) || restaurantSlug.length < 3) {
    throw new OnboardingError("Restaurant URL must be 3–63 letters, numbers, or hyphen-separated words.", "INVALID_INPUT");
  }

  let ownerPhone: string | null = null;
  if (input.ownerPhone !== undefined && input.ownerPhone !== null) {
    if (typeof input.ownerPhone !== "string") {
      throw new OnboardingError("Admin phone must be text.", "INVALID_INPUT");
    }
    const trimmed = input.ownerPhone.trim();
    if (trimmed.length > 32) {
      throw new OnboardingError("Admin phone must be at most 32 characters.", "INVALID_INPUT");
    }
    ownerPhone = trimmed || null;
  }

  if (typeof input.ownerPassword !== "string") {
    throw new OnboardingError("Password is required and must be text.", "INVALID_INPUT");
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.ownerPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new OnboardingError(error.message, "INVALID_INPUT");
    }
    throw error;
  }

  const prisma = getPrismaClient();

  try {
    return await prisma.$transaction(async (tx) => {
      const permissions = await tx.permission.findMany({
        where: { permissionKey: { in: ALL_KEYS } },
        select: { id: true, permissionKey: true },
      });
      const permissionIdByKey = new Map(permissions.map(({ id, permissionKey }) => [permissionKey, id]));
      if (permissionIdByKey.size !== ALL_KEYS.length) {
        const missing = ALL_KEYS.filter((k) => !permissionIdByKey.has(k));
        throw new OnboardingError(
          `Permission catalog is incomplete. Missing ${missing.length} keys (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}). Run 'npm run db:seed' to populate the global permission catalog before onboarding restaurants.`,
          "CONFIGURATION",
        );
      }

      const restaurant = await tx.restaurant.create({
        data: {
          name: restaurantName,
          slug: restaurantSlug,
          settings: { create: {} },
        },
        select: { id: true, name: true, slug: true },
      });

      await tx.role.createMany({
        data: Object.keys(DEFAULT_ROLES).map((name) => ({
          restaurantId: restaurant.id,
          name,
          isSystem: true,
        })),
      });
      const roles = await tx.role.findMany({
        where: { restaurantId: restaurant.id },
        select: { id: true, name: true },
      });
      const roleIdByName = new Map(roles.map(({ id, name }) => [name, id]));

      const rolePermissionRows = Object.entries(DEFAULT_ROLES).flatMap(([name, keys]) => {
        const roleId = roleIdByName.get(name);
        if (!roleId) throw new OnboardingError(`Default role ${name} was not created.`, "CONFIGURATION");
        return keys.map((permissionKey) => {
          const permissionId = permissionIdByKey.get(permissionKey);
          if (!permissionId) {
            throw new OnboardingError(`Permission ${permissionKey} was not found in catalog.`, "CONFIGURATION");
          }
          return { roleId, permissionId };
        });
      });
      await tx.rolePermission.createMany({ data: rolePermissionRows });

      const admin = await tx.user.create({
        data: {
          restaurantId: restaurant.id,
          name: ownerName,
          email: ownerEmail,
          phone: ownerPhone,
          passwordHash,
        },
        select: { id: true, name: true, email: true },
      });
      const adminRoleId = roleIdByName.get("Admin");
      if (!adminRoleId) throw new OnboardingError("The default Admin role was not created.", "CONFIGURATION");

      await tx.userRole.create({
        data: { userId: admin.id, roleId: adminRoleId, restaurantId: restaurant.id },
      });
      await tx.auditLog.create({
        data: {
          restaurantId: restaurant.id,
          userId: admin.id,
          action: "restaurant.onboarded",
          entity: "Restaurant",
          entityId: restaurant.id,
          metadata: { adminUserId: admin.id, roleCount: roles.length },
        },
      });

      return {
        restaurant,
        admin,
        roles: roles.map(({ name }) => name).sort(),
      };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new OnboardingError("That restaurant URL or admin email is already in use.", "CONFLICT");
    }
    throw error;
  }
}

