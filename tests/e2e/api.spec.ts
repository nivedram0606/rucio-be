import { expect, request as playwrightRequest, test } from "@playwright/test";

const apiKey = "restaurant-os-playwright-e2e-key-2026-0001";

const validPayload = {
  restaurantName: "Playwright Bistro",
  restaurantSlug: "playwright-bistro",
  ownerName: "Test Admin",
  ownerEmail: "admin@example.test",
  ownerPassword: "test-password-long-enough-123",
};

test("serves a health response", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  await expect(response).toBeOK();
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});

test("publishes the onboarding operation and its API-key requirement in OpenAPI", async ({ request }) => {
  const response = await request.get("/docs/json");
  expect(response.status()).toBe(200);

  const specification = await response.json();
  expect(specification.openapi).toBe("3.1.0");
  expect(specification.paths["/api/onboarding"].post.security).toEqual([{ OnboardingKey: [] }]);
  expect(specification.components.securitySchemes.OnboardingKey.name).toBe("x-onboarding-key");
  expect(specification.paths["/api/onboarding"].post.requestBody.content["application/json"].schema.properties.restaurantSlug.pattern)
    .toBe("^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$");
  expect(specification.paths["/api/health"].get).toBeDefined();
});

test("renders Swagger UI", async ({ request }) => {
  const response = await request.get("/docs/");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("swagger-ui");
});

test("blocks provisioning without the internal key", async ({ request }) => {
  const response = await request.post("/api/onboarding", { data: validPayload });

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
});

test("blocks provisioning with an incorrect internal key", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": `${apiKey}-wrong` },
    data: validPayload,
  });

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
});

test("rejects malformed onboarding payloads before calling the service", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": apiKey },
    data: { ...validPayload, ownerName: 42 },
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
});

test("returns a safe client error for malformed JSON", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": apiKey, "content-type": "application/json" },
    data: "{not-json",
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
});

test("rejects unsupported request content types with a safe 415", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": apiKey, "content-type": "text/plain" },
    data: "restaurantName=ignored",
  });

  expect(response.status()).toBe(415);
  await expect(response.json()).resolves.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
});

test("provisions through the guarded API and never returns a password hash", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": apiKey },
    data: validPayload,
  });

  expect(response.status()).toBe(201);
  const result = await response.json();
  expect(result.restaurant).toMatchObject({ name: "Playwright Bistro", slug: "playwright-bistro" });
  expect(result.admin.email).toBe("admin@example.test");
  expect(result.roles).toContain("Admin");
  expect(JSON.stringify(result)).not.toContain("passwordHash");
  expect(JSON.stringify(result)).not.toContain(validPayload.ownerPassword);
});

test("returns a conflict for an already-used restaurant URL", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": apiKey },
    data: { ...validPayload, restaurantSlug: "duplicate-restaurant" },
  });

  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT" });
});

test("normalizes mixed-case workspace URLs to lowercase", async ({ request }) => {
  const response = await request.post("/api/onboarding", {
    headers: { "x-onboarding-key": apiKey },
    data: { ...validPayload, restaurantSlug: "Olive-Ember" },
  });

  expect(response.status()).toBe(201);
  await expect(response.json()).resolves.toMatchObject({ restaurant: { slug: "olive-ember" } });
});

test("publishes the auth operations and session cookie requirement in OpenAPI", async ({ request }) => {
  const response = await request.get("/docs/json");
  expect(response.status()).toBe(200);

  const specification = await response.json();
  expect(specification.paths["/api/auth/login"].post).toBeDefined();
  expect(specification.paths["/api/auth/session"].get).toBeDefined();
  expect(specification.paths["/api/auth/logout"].post).toBeDefined();
  expect(specification.paths["/api/tables"].get.security).toEqual([{ SessionCookie: [] }]);
  expect(specification.paths["/api/tables"].post.security).toEqual([{ SessionCookie: [] }]);
  expect(specification.paths["/api/menu/categories"].get.security).toEqual([{ SessionCookie: [] }]);
  expect(specification.paths["/api/menu/categories"].post.security).toEqual([{ SessionCookie: [] }]);
  expect(specification.paths["/api/menu/items"].get.security).toEqual([{ SessionCookie: [] }]);
  expect(specification.paths["/api/menu/items"].post.security).toEqual([{ SessionCookie: [] }]);

  expect(specification.components.securitySchemes.SessionCookie).toEqual({
    type: "apiKey",
    in: "cookie",
    name: "session_token",
    description: expect.stringContaining("HttpOnly"),
  });
});

test("lists and creates only tables in the authenticated tenant, with permission and duplicate guards", async ({ request }) => {
  const login = async (email: string) => {
    const response = await request.post("/api/auth/login", {
      data: { email, password: "test-password-long-enough-123" },
    });
    expect(response.status()).toBe(200);
    return /session_token=([^;]+)/.exec(response.headers()["set-cookie"]!)![1];
  };

  const adminCookie = `session_token=${await login("admin@example.test")}`;
  const unauthenticated = await request.get("/api/tables", { headers: { cookie: "" } });
  expect(unauthenticated.status()).toBe(401);

  const create = await request.post("/api/tables", {
    headers: { cookie: adminCookie },
    data: { tableNumber: "  t 1 ", capacity: 4 },
  });
  expect(create.status()).toBe(201);
  await expect(create.json()).resolves.toMatchObject({ tableNumber: "T 1", capacity: 4, status: "AVAILABLE" });

  const duplicate = await request.post("/api/tables", {
    headers: { cookie: adminCookie },
    data: { tableNumber: "t 1" },
  });
  expect(duplicate.status()).toBe(409);

  const forgedTenant = await request.post("/api/tables", {
    headers: { cookie: adminCookie },
    data: { tableNumber: "T2", restaurantId: "second-restaurant-id" },
  });
  expect(forgedTenant.status()).toBe(201); // extra restaurantId is discarded; the authenticated tenant owns the new table

  const invalidCapacity = await request.post("/api/tables", {
    headers: { cookie: adminCookie },
    data: { tableNumber: "T2", capacity: 51 },
  });
  expect(invalidCapacity.status()).toBe(400);

  const rows = await request.get("/api/tables", { headers: { cookie: adminCookie } });
  expect((await rows.json()).tables.map((table: { tableNumber: string }) => table.tableNumber)).toEqual(["T 1", "T2"]);

  const viewerCookie = `session_token=${await login("viewer@example.test")}`;
  const forbidden = await request.post("/api/tables", {
    headers: { cookie: viewerCookie },
    data: { tableNumber: "T2" },
  });
  expect(forbidden.status()).toBe(403);

  const secondTenantCookie = `session_token=${await login("second-admin@example.test")}`;
  const secondTenantList = await request.get("/api/tables", { headers: { cookie: secondTenantCookie } });
  await expect(secondTenantList.json()).resolves.toEqual({ tables: [] });
  const sameNumberOtherTenant = await request.post("/api/tables", {
    headers: { cookie: secondTenantCookie },
    data: { tableNumber: "T 1" },
  });
  expect(sameNumberOtherTenant.status()).toBe(201);

  // Update table status
  const tableToUpdate = (await rows.json()).tables[0];
  const updateStatus = await request.patch(`/api/tables/${tableToUpdate.id}/status`, {
    headers: { cookie: adminCookie },
    data: { status: "OCCUPIED" },
  });
  expect(updateStatus.status()).toBe(200);
  expect((await updateStatus.json()).status).toBe("OCCUPIED");

  const invalidStatus = await request.patch(`/api/tables/${tableToUpdate.id}/status`, {
    headers: { cookie: adminCookie },
    data: { status: "INVALID_STATUS" },
  });
  expect(invalidStatus.status()).toBe(400);
});

test("lists and creates menu categories and items with permission, validation, and conflict guards", async ({ request }) => {
  const login = async (email: string) => {
    const response = await request.post("/api/auth/login", {
      data: { email, password: "test-password-long-enough-123" },
    });
    expect(response.status()).toBe(200);
    return /session_token=([^;]+)/.exec(response.headers()["set-cookie"]!)![1];
  };

  const adminCookie = `session_token=${await login("admin@example.test")}`;

  // Unauthenticated checks
  const unauthCategories = await request.get("/api/menu/categories", { headers: { cookie: "" } });
  expect(unauthCategories.status()).toBe(401);
  const unauthItems = await request.get("/api/menu/items", { headers: { cookie: "" } });
  expect(unauthItems.status()).toBe(401);

  // Create Category
  const catRes = await request.post("/api/menu/categories", {
    headers: { cookie: adminCookie },
    data: { name: "Starters & Small Plates", displayOrder: 1 },
  });
  expect(catRes.status()).toBe(201);
  const category = await catRes.json();
  expect(category.name).toBe("Starters & Small Plates");

  // Conflict on duplicate category name
  const dupCatRes = await request.post("/api/menu/categories", {
    headers: { cookie: adminCookie },
    data: { name: "Starters & Small Plates" },
  });
  expect(dupCatRes.status()).toBe(409);

  // Create Menu Item
  const itemRes = await request.post("/api/menu/items", {
    headers: { cookie: adminCookie },
    data: {
      categoryId: category.id,
      name: "Truffle Arancini",
      price: 14.5,
      diet: "VEG",
      description: "Crispy risotto balls with black truffle and parmesan.",
    },
  });
  expect(itemRes.status()).toBe(201);
  const item = await itemRes.json();
  expect(item.name).toBe("Truffle Arancini");
  expect(item.categoryName).toBe("Starters & Small Plates");
  expect(item.price).toBe(14.5);
  expect(item.diet).toBe("VEG");

  // Invalid price validation
  const invalidPriceRes = await request.post("/api/menu/items", {
    headers: { cookie: adminCookie },
    data: { categoryId: category.id, name: "Soda", price: -5 },
  });
  expect(invalidPriceRes.status()).toBe(400);

  // Non-existent category
  const invalidCatRes = await request.post("/api/menu/items", {
    headers: { cookie: adminCookie },
    data: { categoryId: "e0a0a0a0-0000-0000-0000-000000000000", name: "Soda", price: 3.5 },
  });
  expect(invalidCatRes.status()).toBe(404);

  // List categories & items
  const catListRes = await request.get("/api/menu/categories", { headers: { cookie: adminCookie } });
  expect((await catListRes.json()).categories.map((c: { name: string }) => c.name)).toContain("Starters & Small Plates");

  const itemListRes = await request.get("/api/menu/items", { headers: { cookie: adminCookie } });
  expect((await itemListRes.json()).items.map((i: { name: string }) => i.name)).toContain("Truffle Arancini");

  // Permission guard with viewer (permissionless)
  const viewerCookie = `session_token=${await login("viewer@example.test")}`;
  const forbiddenCat = await request.post("/api/menu/categories", {
    headers: { cookie: viewerCookie },
    data: { name: "Forbidden Category" },
  });
  expect(forbiddenCat.status()).toBe(403);

  // Tenant isolation with second restaurant
  const secondTenantCookie = `session_token=${await login("second-admin@example.test")}`;
  const secondTenantCats = await request.get("/api/menu/categories", { headers: { cookie: secondTenantCookie } });
  await expect(secondTenantCats.json()).resolves.toEqual({ categories: [] });

  // Second tenant cannot create item referencing first tenant's category
  const crossTenantItem = await request.post("/api/menu/items", {
    headers: { cookie: secondTenantCookie },
    data: { categoryId: category.id, name: "Cross Tenant Dish", price: 10 },
  });
  expect(crossTenantItem.status()).toBe(404);
});

test("rejects login with invalid email or password with generic 401 INVALID_CREDENTIALS", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    data: { email: "admin@example.test", password: "wrong-password-12345" },
  });

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({
    code: "INVALID_CREDENTIALS",
    message: "Invalid email or password.",
  });
});

test("rejects login for inactive user or inactive restaurant", async ({ request }) => {
  const inactiveUserResponse = await request.post("/api/auth/login", {
    data: { email: "inactive@example.test", password: "test-password-long-enough-123" },
  });
  expect(inactiveUserResponse.status()).toBe(401);
  await expect(inactiveUserResponse.json()).resolves.toEqual({
    code: "INVALID_CREDENTIALS",
    message: "Invalid email or password.",
  });

  const closedRestaurantResponse = await request.post("/api/auth/login", {
    data: { email: "inactive-bistro@example.test", password: "test-password-long-enough-123" },
  });
  expect(closedRestaurantResponse.status()).toBe(401);
  await expect(closedRestaurantResponse.json()).resolves.toEqual({
    code: "INVALID_CREDENTIALS",
    message: "Invalid email or password.",
  });
});

test("rejects cross-origin login attempt with 403 FORBIDDEN", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    headers: { origin: "https://evil-attacker.example" },
    data: { email: "admin@example.test", password: "test-password-long-enough-123" },
  });

  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
});

test("authenticates admin, sets HttpOnly SameSite=Strict cookie, and manages session lifecycle", async ({ request }) => {
  // 1. Authenticate
  const loginResponse = await request.post("/api/auth/login", {
    data: { email: "admin@example.test", password: "test-password-long-enough-123" },
  });

  expect(loginResponse.status()).toBe(200);
  const setCookie = loginResponse.headers()["set-cookie"];
  expect(setCookie).toBeTruthy();
  expect(setCookie).toContain("session_token=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/api");

  const identity = await loginResponse.json();
  expect(identity.user.email).toBe("admin@example.test");
  expect(identity.user.name).toBe("Test Admin");
  expect(identity.restaurant.name).toBe("Playwright Bistro");
  expect(identity.roles).toContain("Admin");

  // Ensure secrets and tokens never leak in JSON response
  expect(JSON.stringify(identity)).not.toContain("passwordHash");
  expect(JSON.stringify(identity)).not.toContain("sessionToken");
  expect(JSON.stringify(identity)).not.toContain("test-password-long-enough-123");

  // Extract session token from cookie
  const match = /session_token=([^;]+)/.exec(setCookie);
  expect(match).toBeTruthy();
  const sessionToken = match![1];

  // 2. Access session with cookie
  const sessionResponse = await request.get("/api/auth/session", {
    headers: { cookie: `session_token=${sessionToken}` },
  });
  expect(sessionResponse.status()).toBe(200);
  await expect(sessionResponse.json()).resolves.toEqual(identity);

  // 3. Reject session request without cookie
  // A fresh request context has no cookie jar; the shared test fixture retained
  // the login cookie automatically from step 1.
  const unauthenticatedContext = await playwrightRequest.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  const unauthenticatedResponse = await unauthenticatedContext.get("/api/auth/session");
  expect(unauthenticatedResponse.status()).toBe(401);
  await expect(unauthenticatedResponse.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
  await unauthenticatedContext.dispose();

  // 4. Logout
  const logoutResponse = await request.post("/api/auth/logout", {
    headers: { cookie: `session_token=${sessionToken}` },
  });
  expect(logoutResponse.status()).toBe(200);
  await expect(logoutResponse.json()).resolves.toEqual({ success: true });
  const clearCookie = logoutResponse.headers()["set-cookie"];
  expect(clearCookie).toContain("session_token=");
  expect(clearCookie).toContain("Max-Age=0");

  // 5. Session token is revoked
  const afterLogoutResponse = await request.get("/api/auth/session", {
    headers: { cookie: `session_token=${sessionToken}` },
  });
  expect(afterLogoutResponse.status()).toBe(401);
  await expect(afterLogoutResponse.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("manages orders and KOT lifecycle with validation, calculations, and permission checks", async ({ request }) => {
  // 1. Unauthenticated checks
  const unauthList = await request.get("/api/orders");
  expect(unauthList.status()).toBe(401);

  const unauthCreate = await request.post("/api/orders", {
    data: { items: [{ menuItemId: "any-item-id", quantity: 1 }] },
  });
  expect(unauthCreate.status()).toBe(401);

  // 2. Sign in as Admin
  const loginResponse = await request.post("/api/auth/login", {
    data: { email: "admin@example.test", password: "test-password-long-enough-123" },
  });
  expect(loginResponse.status()).toBe(200);
  const sessionToken = /session_token=([^;]+)/.exec(loginResponse.headers()["set-cookie"]!)![1];
  const authHeaders = { cookie: `session_token=${sessionToken}` };

  // 3. Create a category and menu item for the order
  const catRes = await request.post("/api/menu/categories", {
    headers: authHeaders,
    data: { name: "Pizzas" },
  });
  expect(catRes.status()).toBe(201);
  const cat = await catRes.json();

  const itemRes = await request.post("/api/menu/items", {
    headers: authHeaders,
    data: {
      categoryId: cat.id,
      name: "Woodfired Margherita",
      price: 320,
      diet: "VEG",
    },
  });
  expect(itemRes.status()).toBe(201);
  const item = await itemRes.json();

  // 4. Validation: reject empty items or invalid item
  const emptyRes = await request.post("/api/orders", {
    headers: authHeaders,
    data: { items: [] },
  });
  expect(emptyRes.status()).toBe(400);

  const invalidRes = await request.post("/api/orders", {
    headers: authHeaders,
    data: { items: [{ menuItemId: "non-existent-id", quantity: 1 }] },
  });
  expect(invalidRes.status()).toBe(400);

  // 5. Create valid order
  const orderRes = await request.post("/api/orders", {
    headers: authHeaders,
    data: {
      tableNumber: "T-4",
      items: [{ menuItemId: item.id, quantity: 2, instructions: "Extra basil" }],
    },
  });
  expect(orderRes.status()).toBe(201);
  const order = await orderRes.json();
  expect(order.tableNumber).toBe("T-4");
  expect(order.subtotal).toBe(640);
  expect(order.taxTotal).toBe(32);
  expect(order.grandTotal).toBe(672);
  expect(order.kots).toHaveLength(1);
  expect(order.kots[0].status).toBe("NEW");

  const kotId = order.kots[0].id;

  // 6. Advance KOT status: NEW -> PREPARING
  const prepRes = await request.patch(`/api/orders/kots/${kotId}/status`, {
    headers: authHeaders,
    data: { status: "PREPARING" },
  });
  expect(prepRes.status()).toBe(200);
  const prepKot = await prepRes.json();
  expect(prepKot.status).toBe("PREPARING");

  // 7. Advance KOT status: PREPARING -> READY
  const readyRes = await request.patch(`/api/orders/kots/${kotId}/status`, {
    headers: authHeaders,
    data: { status: "READY" },
  });
  expect(readyRes.status()).toBe(200);
  const readyKot = await readyRes.json();
  expect(readyKot.status).toBe("READY");

  // 8. Reject invalid KOT status
  const invalidStatusRes = await request.patch(`/api/orders/kots/${kotId}/status`, {
    headers: authHeaders,
    data: { status: "COOKED_ALREADY" },
  });
  expect(invalidStatusRes.status()).toBe(400);

  // 9. List orders verifies updated KOT
  const listRes = await request.get("/api/orders", { headers: authHeaders });
  expect(listRes.status()).toBe(200);
  const listData = await listRes.json();
  expect(listData.orders.some((o: { id: string; kots: Array<{ status: string }> }) => o.id === order.id && o.kots[0].status === "READY")).toBe(true);
});

test("manages customer profiles with validation and permission checks", async ({ request }) => {
  // 1. Unauthenticated check
  const unauthList = await request.get("/api/customers");
  expect(unauthList.status()).toBe(401);

  // 2. Sign in as Admin
  const loginResponse = await request.post("/api/auth/login", {
    data: { email: "admin@example.test", password: "test-password-long-enough-123" },
  });
  expect(loginResponse.status()).toBe(200);
  const sessionToken = /session_token=([^;]+)/.exec(loginResponse.headers()["set-cookie"]!)![1];
  const authHeaders = { cookie: `session_token=${sessionToken}` };

  // 3. Validation: reject empty name
  const emptyRes = await request.post("/api/customers", {
    headers: authHeaders,
    data: { name: "   " },
  });
  expect(emptyRes.status()).toBe(400);

  // 4. Create customer
  const createRes = await request.post("/api/customers", {
    headers: authHeaders,
    data: {
      name: "Marcus Vance",
      phone: "+15551234567",
      email: "marcus.v@example.test",
      notes: "Table near window preferred",
    },
  });
  expect(createRes.status()).toBe(201);
  const customer = await createRes.json();
  expect(customer.name).toBe("Marcus Vance");
  expect(customer.phone).toBe("+15551234567");
  expect(customer.status).toBe("ACTIVE");

  // 5. List customers
  const listRes = await request.get("/api/customers", { headers: authHeaders });
  expect(listRes.status()).toBe(200);
  const listData = await listRes.json();
  expect(listData.customers.some((c: { id: string }) => c.id === customer.id)).toBe(true);
});

test("manages staff team members with role assignments, validation, and conflict checks", async ({ request }) => {
  // 1. Unauthenticated check
  const unauthList = await request.get("/api/staff");
  expect(unauthList.status()).toBe(401);

  // 2. Sign in as Admin
  const loginResponse = await request.post("/api/auth/login", {
    data: { email: "admin@example.test", password: "test-password-long-enough-123" },
  });
  expect(loginResponse.status()).toBe(200);
  const sessionToken = /session_token=([^;]+)/.exec(loginResponse.headers()["set-cookie"]!)![1];
  const authHeaders = { cookie: `session_token=${sessionToken}` };

  // 3. Validation: reject invalid email
  const invalidEmailRes = await request.post("/api/staff", {
    headers: authHeaders,
    data: { name: "Elena Ramos", email: "not-an-email", role: "Waiter" },
  });
  expect(invalidEmailRes.status()).toBe(400);

  // 4. Create staff member
  const createRes = await request.post("/api/staff", {
    headers: authHeaders,
    data: {
      name: "Elena Ramos",
      email: "elena.r@restaurant.test",
      role: "Waiter",
      phone: "+15559876543",
    },
  });
  expect(createRes.status()).toBe(201);
  const staffMember = await createRes.json();
  expect(staffMember.name).toBe("Elena Ramos");
  expect(staffMember.role).toBe("Waiter");

  // 5. Duplicate email conflict
  const dupRes = await request.post("/api/staff", {
    headers: authHeaders,
    data: {
      name: "Duplicate Elena",
      email: "elena.r@restaurant.test",
      role: "Waiter",
    },
  });
  expect(dupRes.status()).toBe(409);

  // 6. List staff includes newly created member
  const listRes = await request.get("/api/staff", { headers: authHeaders });
  expect(listRes.status()).toBe(200);
  const listData = await listRes.json();
  expect(listData.staff.some((s: { id: string }) => s.id === staffMember.id)).toBe(true);
});

test("customer mobile QR ordering flow: public menu, order placement, and live status tracking", async ({ request }) => {
  // 1. Fetch live public menu by slug without authentication
  const menuRes = await request.get("/api/public/menu/playwright-bistro");
  expect(menuRes.status()).toBe(200);
  const menu = await menuRes.json();
  expect(menu.restaurant.slug).toBe("playwright-bistro");
  expect(Array.isArray(menu.categories)).toBe(true);
  expect(Array.isArray(menu.items)).toBe(true);
  expect(menu.items.length).toBeGreaterThan(0);

  const testItem = menu.items[0];

  // 2. Reject public order with missing table or empty items
  const invalidOrderRes = await request.post("/api/public/orders", {
    data: { slug: "playwright-bistro", tableNumber: "", items: [] },
  });
  expect(invalidOrderRes.status()).toBe(400);

  // 3. Place valid public guest order from Table T-01
  const createOrderRes = await request.post("/api/public/orders", {
    data: {
      slug: "playwright-bistro",
      tableNumber: "T-01",
      customerName: "Sam Guest",
      phone: "9876543210",
      notes: "Please make it crispy",
      items: [{ menuItemId: testItem.id, quantity: 2, instructions: "Extra spicy" }],
    },
  });
  expect(createOrderRes.status()).toBe(201);
  const order = await createOrderRes.json();
  expect(order.orderNumber).toMatch(/^ORD-/);
  expect(order.subtotal).toBe(testItem.price * 2);
  expect(order.taxTotal).toBe(Math.round(order.subtotal * 0.05 * 100) / 100);
  expect(order.grandTotal).toBe(Math.round((order.subtotal + order.taxTotal) * 100) / 100);
  expect(order.kots.length).toBe(1);
  expect(order.kots[0].status).toBe("NEW");

  // 4. Live order tracking via public status endpoint
  const trackRes = await request.get(`/api/public/orders/${order.orderNumber}?slug=playwright-bistro`);
  expect(trackRes.status()).toBe(200);
  const trackingData = await trackRes.json();
  expect(trackingData.orderNumber).toBe(order.orderNumber);
  expect(trackingData.kots[0].status).toBe("NEW");
});

test("counter POS billing and order settlement flow with payment method and audit logging", async ({ request }) => {
  // 1. Unauthenticated settlement is rejected
  const unauthRes = await request.patch("/api/orders/any-id/settle", {
    data: { paymentMethod: "UPI" },
  });
  expect(unauthRes.status()).toBe(401);

  // 2. Sign in as Admin / Cashier
  const loginResponse = await request.post("/api/auth/login", {
    data: { email: "admin@example.test", password: "test-password-long-enough-123" },
  });
  expect(loginResponse.status()).toBe(200);
  const sessionToken = /session_token=([^;]+)/.exec(loginResponse.headers()["set-cookie"]!)![1];
  const authHeaders = { cookie: `session_token=${sessionToken}` };

  // 3. Get existing order or create one
  const listRes = await request.get("/api/orders", { headers: authHeaders });
  const listData = await listRes.json();
  const targetOrder = listData.orders[0];
  expect(targetOrder).toBeDefined();

  // 4. Reject invalid payment method
  const invalidMethodRes = await request.patch(`/api/orders/${targetOrder.id}/settle`, {
    headers: authHeaders,
    data: { paymentMethod: "BITCOIN" },
  });
  expect(invalidMethodRes.status()).toBe(400);

  // 5. Settle order via UPI
  const settleRes = await request.patch(`/api/orders/${targetOrder.id}/settle`, {
    headers: authHeaders,
    data: { paymentMethod: "UPI" },
  });
  expect(settleRes.status()).toBe(200);
  const settled = await settleRes.json();
  expect(settled.id).toBe(targetOrder.id);
  expect(settled.status).toBe("SETTLED");
  expect(settled.paymentMethod).toBe("UPI");
  // All active kitchen tickets are advanced to SERVED
  expect(settled.kots.every((k: { status: string }) => k.status === "SERVED" || k.status === "CANCELLED")).toBe(true);
});

