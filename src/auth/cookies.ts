export const SESSION_COOKIE_NAME = "session_token";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type CookieSerializeOptions = {
  isProduction?: boolean;
  maxAgeMs?: number;
};

/**
 * Parses raw Cookie header string into key-value pairs.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header || typeof header !== "string") {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const chunk of header.split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(rawValue);
      } catch {
        cookies[name] = rawValue;
      }
    }
  }
  return cookies;
}

/**
 * Serializes an HttpOnly, SameSite=Strict session cookie scoped to /api.
 */
export function serializeSessionCookie(token: string, options: CookieSerializeOptions = {}): string {
  const isProduction = options.isProduction ?? false;
  const maxAgeMs = options.maxAgeMs ?? SESSION_TTL_MS;
  const maxAgeSeconds = Math.max(0, Math.floor(maxAgeMs / 1000));

  const directives = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (isProduction) {
    directives.push("Secure");
  }

  return directives.join("; ");
}

/**
 * Serializes a Set-Cookie header that clears the session cookie immediately.
 */
export function serializeClearSessionCookie(options: Pick<CookieSerializeOptions, "isProduction"> = {}): string {
  const isProduction = options.isProduction ?? false;
  const directives = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];

  if (isProduction) {
    directives.push("Secure");
  }

  return directives.join("; ");
}

function isLoopback(hostWithPort: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${hostWithPort}`).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/**
 * Validates request origin against Host header and loopback restrictions to protect
 * state-changing cookie-authenticated endpoints from CSRF and cross-origin attacks.
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  secFetchSite?: string | string[] | undefined,
): boolean {
  if (typeof secFetchSite === "string" && secFetchSite === "cross-site") {
    return false;
  }

  // If no Origin header was provided (direct programmatic client or same-origin navigations)
  if (!originHeader) {
    return true;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  // Exact host match between Origin URL host and Host header
  if (hostHeader && originUrl.host.toLowerCase() === hostHeader.toLowerCase()) {
    return true;
  }

  // Local development / proxy support between loopback ports (e.g. Vite 4173 -> Fastify 4317)
  if (isLoopback(originUrl.host) && (!hostHeader || isLoopback(hostHeader))) {
    return true;
  }

  return false;
}
