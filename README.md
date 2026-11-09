# Restaurant OS backend

This package provides the PostgreSQL/Prisma data layer, Fastify API, Swagger documentation, private restaurant onboarding, authentication services, and repeatable permission-catalog seed.

## Local setup

Requires Node.js 22.18+ or 24+ and PostgreSQL. The current Prisma release supports your installed Node.js 26.

```sh
cd backend
npm install
cp .env.example .env
```

Edit `DATABASE_URL` in `.env` to match your local PostgreSQL user, password, and database. `.env` is ignored by Git.

For internal provisioning, set `ONBOARDING_API_KEY` to a random value with at least 32 bytes. For example:

```sh
export ONBOARDING_API_KEY="$(openssl rand -base64 32)"
```

Keep the key private. If it is unset, the onboarding endpoint responds with `503` and creates no records.

## Database commands

```sh
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:seed
```

The initial schema and custom SQL constraints are captured in the migration files under `prisma/migrations/`. Local `restaurant_os` has all three current migrations applied. Use `db:migrate` to apply pending migrations in a development environment; review the migration plan first when connecting a database that contains data you need to preserve.

`db:seed` upserts the global permission catalog from `prisma/seed-permissions.ts`. Default staff roles are restaurant-scoped and should be created during restaurant provisioning, not as global seed data.

The generated Prisma client lives under `src/generated/prisma/` and is build output; do not edit it by hand.

## API, Onboarding, and Authentication

Start the local API with `npm run dev`. `GET /api/health` reports API process health. Swagger UI is at `/docs/`, with OpenAPI JSON at `/docs/json`.

### Onboarding
`POST /api/onboarding` is an **internal bootstrap endpoint**, protected by `x-onboarding-key`. It is not public self-service signup. Before using it, verify the Admin email out of band, run migrations, and run `npm run db:seed` to populate the global permission catalog. The service refuses to onboard when any permission keys are missing. The endpoint returns only the restaurant, Admin profile, and role names; the response schema strips any extra fields such as password hashes.

### Authentication & Sessions
- `POST /api/auth/login`: Authenticates an Admin or staff user with email and password. Normalizes email to lowercase, verifies scrypt password hash, enforces active/non-deleted checks on both the user and restaurant, generates an opaque random 256-bit session token, stores only its SHA-256 hash in `RefreshToken`, and returns an `HttpOnly`, `SameSite=Strict`, `Path=/api` cookie (with `Secure` in production). To prevent user enumeration, unknown emails execute constant-time scrypt verification against a precomputed dummy hash.
- `GET /api/auth/session`: Derives tenant identity strictly from the authenticated session cookie. Validates token hash, expiry, revocation, and active status. Returns minimal safe identity (`user`, `restaurant`, `roles`). Client-supplied tenant IDs are never accepted.
- `POST /api/auth/logout`: Revokes the session token record in `RefreshToken` and clears the browser session cookie.
- **CSRF & Same-Origin Protection**: State-changing authentication requests (`/api/auth/login`, `/api/auth/logout`) enforce same-origin verification against the `Host` header and loopback bindings. Cross-origin requests are rejected with `403 FORBIDDEN`.

### Floor & Tables
- `GET /api/tables`: Requires an authenticated session and `tables.view`. Returns active tables for the session restaurant only, ordered by normalized table number.
- `POST /api/tables`: Requires an authenticated session and `tables.create`. Accepts `tableNumber` and optional `capacity` (1–50; defaults to 4), normalizes the table number, and returns `409` for a duplicate within the same restaurant.
- Tenant and audit actor IDs come from the verified session; the request body cannot choose a tenant. Table creation and its `TABLE_CREATED` audit entry are written in one transaction.
- Swagger includes both operations. Automated tests use in-memory fixtures; they do not verify a live PostgreSQL write.

### Menu & Dish Catalog
- `GET /api/menu/categories`: Requires an authenticated session and `menu.view`. Returns active menu categories for the session restaurant only, ordered by display rank and name.
- `POST /api/menu/categories`: Requires an authenticated session and `menu.create`. Accepts `name` (1–80 chars) and optional `rank`. Returns `409` for duplicate category names within the same restaurant.
- `GET /api/menu/items`: Requires an authenticated session and `menu.view`. Returns active menu items for the session restaurant with category IDs, diet flags (`VEG`, `NON_VEG`, `EGG`), prices, and tax rates.
- `POST /api/menu/items`: Requires an authenticated session and `menu.create`. Accepts `categoryId`, `name`, `price`, optional `diet`, optional `description`, and optional `taxRate`. Rejects items referencing categories from another restaurant or inactive categories.
- Category and item creation each commit an atomic `AuditLog` entry (`CATEGORY_CREATED` / `ITEM_CREATED`) in the same transaction.

## Automated checks

```sh
npm test
npm run test:unit
npm run test:e2e
```

Vitest runs unit tests for password handling, auth session lifecycle, cookie serialization, same-origin validation, onboarding transactions, table management, and menu category/item services with mocked storage. Playwright runs HTTP-level end-to-end tests for validation, guarded provisioning, health, login, session lifecycle, table permissions/conflicts, menu catalog isolation/validation, and OpenAPI/Swagger using isolated in-memory fixtures. These API tests do not write to a real database or require a browser download.
