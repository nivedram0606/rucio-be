import { randomBytes } from "node:crypto";
import { getPrismaClient } from "../db/client";
import { hashPassword } from "../auth/password";

export type StaffMemberDto = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  createdAt: string;
};

export class StaffManagementError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_INPUT" | "CONFLICT" | "NOT_FOUND",
  ) {
    super(message);
    this.name = "StaffManagementError";
  }
}

export function normalizeStaffName(value: unknown): string {
  if (typeof value !== "string") {
    throw new StaffManagementError("Full name must be text.", "INVALID_INPUT");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 100) {
    throw new StaffManagementError("Name must be between 1 and 100 characters.", "INVALID_INPUT");
  }
  return normalized;
}

export function normalizeStaffEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new StaffManagementError("Email address must be text.", "INVALID_INPUT");
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 255) {
    throw new StaffManagementError("Please provide a valid email address.", "INVALID_INPUT");
  }
  return trimmed;
}

export function normalizeStaffPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new StaffManagementError("Phone number must be text.", "INVALID_INPUT");
  }
  const trimmed = value.trim();
  if (trimmed.length > 30) {
    throw new StaffManagementError("Phone number must not exceed 30 characters.", "INVALID_INPUT");
  }
  return trimmed;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function listRestaurantStaff(restaurantId: string): Promise<StaffMemberDto[]> {
  const prisma = getPrismaClient();
  const users = await prisma.user.findMany({
    where: { restaurantId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      userRoles: {
        select: {
          role: {
            select: { name: true },
          },
        },
      },
    },
  });

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.userRoles[0]?.role.name || "Staff",
    status: u.status,
    createdAt: u.createdAt.toISOString(),
  }));
}

export async function createRestaurantStaff(input: {
  restaurantId: string;
  actorUserId: string;
  name: unknown;
  email: unknown;
  role: unknown;
  phone?: unknown;
}): Promise<StaffMemberDto> {
  const name = normalizeStaffName(input.name);
  const email = normalizeStaffEmail(input.email);
  const phone = normalizeStaffPhone(input.phone);

  if (typeof input.role !== "string" || !input.role.trim()) {
    throw new StaffManagementError("A valid role must be specified.", "INVALID_INPUT");
  }
  const roleName = input.role.trim();

  const prisma = getPrismaClient();

  // Find the requested role scoped strictly to the current restaurant
  const role = await prisma.role.findFirst({
    where: {
      restaurantId: input.restaurantId,
      name: roleName,
    },
  });

  if (!role) {
    throw new StaffManagementError(`Role "${roleName}" not found in this restaurant.`, "NOT_FOUND");
  }

  // Provision an unguessable placeholder password hash for the pending invitation
  const tempPassword = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(tempPassword);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          restaurantId: input.restaurantId,
          name,
          email,
          phone,
          passwordHash,
          status: "ACTIVE",
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          status: true,
          createdAt: true,
        },
      });

      await tx.userRole.create({
        data: {
          restaurantId: input.restaurantId,
          userId: user.id,
          roleId: role.id,
        },
      });

      await tx.auditLog.create({
        data: {
          restaurantId: input.restaurantId,
          userId: input.actorUserId,
          action: "STAFF_INVITED",
          entity: "User",
          entityId: user.id,
          metadata: { name, email, roleName },
        },
      });

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: role.name,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
      };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new StaffManagementError("A team member with that email address already exists.", "CONFLICT");
    }
    throw error;
  }
}
