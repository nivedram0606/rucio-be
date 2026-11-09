-- Keep raw SQL and trigger evaluation safe when NEW.id is NULL before a NOT NULL
-- constraint is checked. For normal Prisma writes this is equivalent to <>.
CREATE OR REPLACE FUNCTION allocation_within_payment() RETURNS trigger AS $$
DECLARE total numeric; pay numeric;
BEGIN
  SELECT amount INTO pay FROM "Payment" WHERE id = NEW."paymentId" FOR UPDATE;
  SELECT COALESCE(SUM("allocatedAmount"),0) INTO total
    FROM "PaymentAllocation"
    WHERE "paymentId" = NEW."paymentId" AND id IS DISTINCT FROM NEW.id;
  IF total + NEW."allocatedAmount" > pay THEN
    RAISE EXCEPTION 'Allocations exceed payment amount';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
