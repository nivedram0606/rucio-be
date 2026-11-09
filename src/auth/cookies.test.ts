import { describe, expect, it } from "vitest";
import {
  isAllowedOrigin,
  parseCookies,
  serializeClearSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from "./cookies";

describe("cookie utilities", () => {
  it("parses cookies safely from headers", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(";;;")).toEqual({});
    expect(parseCookies("session_token=test-token-123; other_cookie=hello%20world")).toEqual({
      session_token: "test-token-123",
      other_cookie: "hello world",
    });
  });

  it("serializes session cookie with HttpOnly, SameSite=Strict, and Path=/api", () => {
    const devCookie = serializeSessionCookie("my-secret-token", { isProduction: false, maxAgeMs: 3600_000 });
    expect(devCookie).toContain(`${SESSION_COOKIE_NAME}=my-secret-token`);
    expect(devCookie).toContain("Path=/api");
    expect(devCookie).toContain("HttpOnly");
    expect(devCookie).toContain("SameSite=Strict");
    expect(devCookie).toContain("Max-Age=3600");
    expect(devCookie).not.toContain("Secure");

    const prodCookie = serializeSessionCookie("my-secret-token", { isProduction: true, maxAgeMs: 3600_000 });
    expect(prodCookie).toContain("Secure");
  });

  it("serializes clear session cookie with Max-Age=0 and epoch expiry", () => {
    const clearCookie = serializeClearSessionCookie({ isProduction: false });
    expect(clearCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(clearCookie).toContain("Path=/api");
    expect(clearCookie).toContain("HttpOnly");
    expect(clearCookie).toContain("SameSite=Strict");
    expect(clearCookie).toContain("Max-Age=0");
    expect(clearCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");

    const prodClearCookie = serializeClearSessionCookie({ isProduction: true });
    expect(prodClearCookie).toContain("Secure");
  });

  it("allows same-origin and local loopback requests", () => {
    // Missing origin allowed (e.g. non-browser API test)
    expect(isAllowedOrigin(undefined, "127.0.0.1:4317")).toBe(true);

    // Exact host match
    expect(isAllowedOrigin("http://127.0.0.1:4317", "127.0.0.1:4317")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", "localhost:3000")).toBe(true);

    // Loopback proxy pair
    expect(isAllowedOrigin("http://127.0.0.1:4173", "127.0.0.1:4317")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1:3000")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5173", "127.0.0.1:3000")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5173", "[::1]:3000")).toBe(true);
  });

  it("rejects cross-origin, cross-site, and malformed origins", () => {
    // Cross-site header
    expect(isAllowedOrigin("http://127.0.0.1:4173", "127.0.0.1:4317", "cross-site")).toBe(false);

    // External domain attacker
    expect(isAllowedOrigin("https://evil.com", "127.0.0.1:3000")).toBe(false);
    expect(isAllowedOrigin("https://attacker.example", "localhost:3000")).toBe(false);

    // Domain spoofing attempt
    expect(isAllowedOrigin("https://127.0.0.1.attacker.com", "127.0.0.1:3000")).toBe(false);

    // Malformed origin
    expect(isAllowedOrigin("not-a-valid-url", "127.0.0.1:3000")).toBe(false);
  });
});
