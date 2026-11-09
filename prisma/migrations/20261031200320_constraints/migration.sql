-- Apply as a custom migration right after the generated initial migration:
--   npx prisma migrate dev --create-only --name constraints   (paste this file in, then migrate dev)
-- NOT YET EXECUTED against a real PostgreSQL instance: review and test before production.

-- ───── CHECK constraints ─────
ALTER TABLE "OrderItem" ADD CONSTRAINT order_item_qty_pos CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "taxRate" >= 0 AND "discountAmount" >= 0 AND "total" >= 0);
ALTER TABLE "InvoiceItem" ADD CONSTRAINT invoice_item_qty_pos CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "taxRate" >= 0);
ALTER TABLE "KotItem" ADD CONSTRAINT kot_item_qty_pos CHECK ("quantity" > 0);
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_amounts CHECK ("subtotal" >= 0 AND "taxTotal" >= 0 AND "discountTotal" >= 0 AND "grandTotal" >= 0 AND "paidAmount" >= 0);
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_discount_pct CHECK ("discountType" IS DISTINCT FROM 'PERCENT' OR ("discountValue" >= 0 AND "discountValue" <= 100));
ALTER TABLE "Payment" ADD CONSTRAINT payment_amount_pos CHECK ("amount" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT payment_tender CHECK ("tenderedAmount" IS NULL OR "tenderedAmount" >= "amount");
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT allocation_pos CHECK ("allocatedAmount" > 0);
ALTER TABLE "MenuItem" ADD CONSTRAINT menu_price_nonneg CHECK ("price" >= 0);
ALTER TABLE "TaxRate" ADD CONSTRAINT tax_rate_range CHECK ("rate" >= 0 AND "rate" <= 100);
ALTER TABLE "RecipeItem" ADD CONSTRAINT recipe_qty_pos CHECK ("quantity" > 0);
ALTER TABLE "OrderIngredientConsumption" ADD CONSTRAINT consumption_qty_nonneg CHECK ("quantity" >= 0);
ALTER TABLE "PurchaseItem" ADD CONSTRAINT purchase_item_nonneg CHECK ("quantity" > 0 AND "unitCost" >= 0 AND "total" >= 0);
ALTER TABLE "Expense" ADD CONSTRAINT expense_amount_pos CHECK ("amount" > 0);
ALTER TABLE "Payroll" ADD CONSTRAINT payroll_amounts CHECK ("grossSalary" >= 0 AND "totalDeductions" >= 0);
ALTER TABLE "PayrollPayment" ADD CONSTRAINT payroll_payment_pos CHECK ("amount" > 0);
ALTER TABLE "Ingredient" ADD CONSTRAINT ingredient_min_nonneg CHECK ("minimumStock" >= 0);
-- Negative current stock is allowed only when the restaurant enables it; enforced in the stock service under row lock.

-- ───── Partial unique indexes ─────
CREATE UNIQUE INDEX one_open_session_per_table ON "TableSession" ("tableId") WHERE status = 'OPEN';
CREATE UNIQUE INDEX one_open_register_per_restaurant ON "CashRegister" ("restaurantId") WHERE status = 'OPEN';
CREATE UNIQUE INDEX one_active_qr_per_table ON "TableQrCode" ("tableId") WHERE "isActive";
CREATE INDEX outbox_pending_idx ON "OutboxEvent" ("nextAttemptAt", sequence) WHERE status = 'PENDING';
CREATE INDEX kot_open_idx ON "KotTicket" ("restaurantId", "createdAt") WHERE status IN ('NEW','ACCEPTED','PREPARING','READY');

-- ───── Immutability triggers ─────
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movement_append_only BEFORE UPDATE OR DELETE ON "InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER financial_txn_append_only BEFORE UPDATE OR DELETE ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER invoice_history_append_only BEFORE UPDATE OR DELETE ON "InvoiceStatusHistory"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Recorded payments and issued invoices are never deleted (status changes only).
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DELETE on % is not allowed; void or soft-delete instead', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_no_delete BEFORE DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payment_no_delete BEFORE DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER order_no_delete BEFORE DELETE ON "Order" FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payroll_no_delete BEFORE DELETE ON "Payroll" FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Locked payroll: header and items cannot change once approved.
CREATE OR REPLACE FUNCTION payroll_lock_guard() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'Payroll' THEN
    -- allowed after lock: APPROVED -> PAID and PAID bookkeeping only
    IF OLD."lockedAt" IS NOT NULL AND (
         NEW."grossSalary" <> OLD."grossSalary" OR NEW."totalDeductions" <> OLD."totalDeductions"
         OR NEW."netSalary" <> OLD."netSalary" OR NEW."employeeId" <> OLD."employeeId"
         OR NEW."payrollMonth" <> OLD."payrollMonth") THEN
      RAISE EXCEPTION 'Locked payroll amounts cannot be edited; create a correction entry';
    END IF;
    RETURN NEW;
  ELSE
    IF EXISTS (SELECT 1 FROM "Payroll" p WHERE p.id = COALESCE(NEW."payrollId", OLD."payrollId") AND p."lockedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'Payroll items of a locked payroll are immutable';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_locked_update BEFORE UPDATE ON "Payroll" FOR EACH ROW EXECUTE FUNCTION payroll_lock_guard();
CREATE TRIGGER payroll_item_locked BEFORE INSERT OR UPDATE OR DELETE ON "PayrollItem" FOR EACH ROW EXECUTE FUNCTION payroll_lock_guard();

-- Allocation sum must never exceed the payment amount (the invoice-balance rule is enforced in the service under FOR UPDATE).
CREATE OR REPLACE FUNCTION allocation_within_payment() RETURNS trigger AS $$
DECLARE total numeric; pay numeric;
BEGIN
  SELECT amount INTO pay FROM "Payment" WHERE id = NEW."paymentId" FOR UPDATE;
  SELECT COALESCE(SUM("allocatedAmount"),0) INTO total FROM "PaymentAllocation" WHERE "paymentId" = NEW."paymentId" AND id <> NEW.id;
  IF total + NEW."allocatedAmount" > pay THEN
    RAISE EXCEPTION 'Allocations exceed payment amount';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER allocation_guard BEFORE INSERT OR UPDATE ON "PaymentAllocation" FOR EACH ROW EXECUTE FUNCTION allocation_within_payment();

-- Optional defence in depth (enable per table once the app sets `SET LOCAL app.restaurant_id = ...` per request):
-- ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation ON "Order" USING ("restaurantId" = current_setting('app.restaurant_id')::uuid);
