// Single source of truth for restaurant-scoped permission keys.
// Share via a common package (e.g. /shared) so backend guards and frontend route guards cannot drift.
// Platform Super Admin is NOT a role: it is the PlatformAdmin model with its own auth and routes.
// Add a permission here only together with its API route and service-layer check.

export const PERMISSIONS = {
  dashboard: ['view'],
  users: ['view', 'create', 'update', 'assign_roles'],
  roles: ['view', 'create', 'update', 'delete'],
  rbac: ['manage'],
  customers: ['view', 'create', 'update'],
  orders: ['view', 'create', 'update', 'accept', 'submit', 'add_items', 'remove_items', 'cancel', 'complete'],
  kot: ['view', 'update_status'],
  tables: ['view', 'create', 'update', 'delete', 'manage_sessions'],
  menu: ['view', 'create', 'update', 'delete'],
  billing: ['view', 'create', 'discount', 'void'],
  payments: ['view', 'record', 'refund', 'void'],
  inventory: ['view', 'create', 'update', 'adjust'],
  suppliers: ['view', 'create', 'update'],
  purchases: ['view', 'create', 'receive', 'cancel'],
  accounting: ['view', 'create_expense', 'update_expense', 'manage_cash_register'],
  employees: ['view', 'create', 'update', 'deactivate'],
  payroll: ['view', 'generate', 'approve', 'pay', 'download_slip'],
  reports: ['view'],
  webhooks: ['manage'],
  audit: ['view'],
  settings: ['manage'],
} as const;

export type Module = keyof typeof PERMISSIONS;

export const ALL_KEYS: string[] = Object.entries(PERMISSIONS).flatMap(([m, actions]) =>
  actions.map((a) => `${m}.${a}`),
);

// Orders lifecycle clarification:
//   orders.complete = close the order after serving AND settlement (cashier/manager),
//   kot.update_status (SERVED) = food delivered to the table (waiter/kitchen).
export const DEFAULT_ROLES: Record<string, string[]> = {
  // Full control inside one restaurant. The last active Admin can never be removed (service rule).
  Admin: ALL_KEYS,

  // Operations only. No role assignment, no payroll generate/approve/pay, no RBAC/webhooks/settings.
  // billing.discount is granted but capped by RestaurantSettings.maxDiscountPctByRole in the billing service.
  Manager: [
    'dashboard.view', 'users.view', 'customers.view', 'customers.create', 'customers.update',
    'orders.view', 'orders.create', 'orders.update', 'orders.accept', 'orders.submit', 'orders.add_items',
    'orders.remove_items', 'orders.cancel', 'orders.complete', 'kot.view', 'kot.update_status',
    'tables.view', 'tables.create', 'tables.update', 'tables.manage_sessions',
    'menu.view', 'menu.create', 'menu.update', 'menu.delete',
    'billing.view', 'billing.create', 'billing.discount', 'billing.void',
    'payments.view', 'payments.record',
    'inventory.view', 'inventory.create', 'inventory.update', 'inventory.adjust',
    'suppliers.view', 'suppliers.create', 'suppliers.update',
    'purchases.view', 'purchases.create', 'purchases.receive',
    'accounting.view', 'accounting.create_expense', 'accounting.manage_cash_register',
    'employees.view', 'payroll.view', 'reports.view',
  ],

  Cashier: [
    'dashboard.view', 'orders.view', 'orders.create', 'orders.add_items', 'orders.complete',
    'tables.view', 'menu.view', 'customers.view', 'customers.create', 'kot.view',
    'billing.view', 'billing.create', 'payments.view', 'payments.record',
    'accounting.manage_cash_register',
  ],

  Waiter: [
    'orders.view', 'orders.create', 'orders.update', 'orders.submit', 'orders.add_items',
    'tables.view', 'tables.manage_sessions', 'menu.view', 'kot.view', 'kot.update_status',
  ],

  // Kitchen sees KOT data only. Kitchen API responses must exclude customer phone, prices and totals.
  'Kitchen Staff': ['kot.view', 'kot.update_status'],

  // "Customer" is not a staff role. QR customers use CustomerQrSession tokens scoped to their table/orders.
};

// Re-checked inside the service layer (not only the route), always audit-logged,
// and where monetary, limited by policy rather than by permission alone.
export const SENSITIVE: string[] = [
  'billing.discount', 'billing.void', 'billing.create',
  'payments.record', 'payments.refund', 'payments.void',
  'orders.cancel', 'inventory.adjust',
  'users.assign_roles', 'roles.delete', 'rbac.manage', 'settings.manage',
  'payroll.generate', 'payroll.approve', 'payroll.pay', 'payroll.download_slip',
  'webhooks.manage',
];

// Privilege-escalation rule for rbac.manage / users.assign_roles:
// an actor may only grant permissions they hold themselves.
export const canDelegate = (actorKeys: Set<string>, granting: string[]) => granting.every((k) => actorKeys.has(k));
