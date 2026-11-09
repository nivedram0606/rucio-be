import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getPrismaClient } from "../db/client";
import { verifyPassword } from "./password";
import { SESSION_TTL_MS } from "./cookies";

export class AuthError extends Error {
  constructor(
    readonly code: "INVALID_CREDENTIALS" | "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthIdentity = {
  user: {
    id: string;
    name: string;
    email: string;
  };
  restaurant: {
    id: string;
    name: string;
    slug: string;
  };
  roles: string[];
  permissions: string[];
};

export type LoginResult = {
  sessionToken: string;
  identity: AuthIdentity;
};

// Formatted dummy hash for constant-time comparison when email is not found
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Computes the SHA-256 hex digest of a raw opaque session token.
 * Only this hash is persisted to the RefreshToken table.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Generates a 256-bit cryptographically random opaque token string.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Authenticates user credentials, validates account and tenant status,
 * persists a hashed session record in RefreshToken, and returns an opaque cookie token
 * alongside minimal safe identity metadata.
 */
export async function authenticateWithPassword(
  emailInput: unknown,
  passwordInput: unknown,
): Promise<LoginResult> {
  if (typeof emailInput !== "string" || typeof passwordInput !== "string") {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const email = emailInput.trim().toLowerCase();
  const password = passwordInput;

  if (!email || !password || email.length > 254 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const prisma = getPrismaClient();

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      restaurant: true,
      userRoles: {
        include: {
          role: {
            include: {
              rolePermissions: { include: { permission: true } },
            },
          },
        },
      },
    },
  });

  if (!user) {
    // Run dummy verify to mitigate user enumeration timing attacks
    await verifyPassword(password, DUMMY_HASH);
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  // Reject inactive or soft-deleted user
  if (user.status !== "ACTIVE" || user.deletedAt !== null) {
    await verifyPassword(password, user.passwordHash);
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  // Reject inactive or soft-deleted restaurant tenant
  if (!user.restaurant || user.restaurant.status !== "ACTIVE" || user.restaurant.deletedAt !== null) {
    await verifyPassword(password, user.passwordHash);
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const sessionToken = generateSessionToken();
  const tokenHash = hashToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const familyId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash,
        expiresAt,
      },
    });

    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
  });

  const identity: AuthIdentity = {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
    restaurant: {
      id: user.restaurant.id,
      name: user.restaurant.name,
      slug: user.restaurant.slug,
    },
    roles: user.userRoles.map((ur) => ur.role.name).sort(),
    permissions: [...new Set(user.userRoles.flatMap((ur) =>
      ur.role.rolePermissions.map((rp) => rp.permission.permissionKey),
    ))].sort(),
  };

  return { sessionToken, identity };
}

/**
 * Validates a session token, ensuring it exists in RefreshToken, is not expired or revoked,
 * and that both the owning user and restaurant tenant remain active and not deleted.
 */
export async function validateSessionToken(rawToken: unknown): Promise<AuthIdentity | null> {
  if (typeof rawToken !== "string" || !rawToken.trim()) {
    return null;
  }

  const tokenHash = hashToken(rawToken.trim());
  const prisma = getPrismaClient();

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          restaurant: true,
          userRoles: {
            include: {
              role: {
                include: {
                  rolePermissions: { include: { permission: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!record) return null;
  if (record.revokedAt !== null) return null;
  if (record.expiresAt.getTime() <= Date.now()) return null;

  const { user } = record;
  if (!user || user.status !== "ACTIVE" || user.deletedAt !== null) return null;
  if (!user.restaurant || user.restaurant.status !== "ACTIVE" || user.restaurant.deletedAt !== null) return null;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
    restaurant: {
      id: user.restaurant.id,
      name: user.restaurant.name,
      slug: user.restaurant.slug,
    },
    roles: user.userRoles.map((ur) => ur.role.name).sort(),
    permissions: [...new Set(user.userRoles.flatMap((ur) =>
      ur.role.rolePermissions.map((rp) => rp.permission.permissionKey),
    ))].sort(),
  };
}

/**
 * Revokes a session token by recording revokedAt timestamp in RefreshToken.
 */
export async function revokeSessionToken(rawToken: unknown): Promise<void> {
  if (typeof rawToken !== "string" || !rawToken.trim()) {
    return;
  }

  const tokenHash = hashToken(rawToken.trim());
  const prisma = getPrismaClient();

  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
