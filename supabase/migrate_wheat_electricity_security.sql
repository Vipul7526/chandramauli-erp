-- ==================================================================================
-- CHANDRAMAULI ERP - COMPLETE SAFE MIGRATION & UPGRADE SCRIPT
-- Run this in Supabase SQL Editor
-- Includes:
-- 1. Soft Delete & 30-Day Recycle Bin with instant delete support
-- 2. Strictly 1 Customer per Mobile Number (active directory)
-- 3. Automatic Real-Time Due/Advance Recalculation Trigger
-- 4. Automatic Daily ₹80 Fixed Electricity Charge + ₹7.77/kWh
-- 5. Wheat Flour Atta Chakki Milling Support
-- 6. In-App Security, Biometric Enrolled Pin Optional / Non-Lock Pin Mandatory
-- Developer: Prince Singh
-- ==================================================================================

-- 1. Add Soft Delete & 30-Day Recycle Bin Columns to Customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_is_deleted ON customers (is_deleted);
CREATE INDEX IF NOT EXISTS idx_customers_scheduled_deletion ON customers (scheduled_deletion_at);

-- 2. Remove duplicate customer rows keeping only the latest one per mobile number (if any)
DELETE FROM customers
WHERE id NOT IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY TRIM(mobile) ORDER BY created_at DESC) as rnum
        FROM customers
        WHERE is_deleted = FALSE OR is_deleted IS NULL
    ) t
    WHERE t.rnum = 1
) AND (is_deleted = FALSE OR is_deleted IS NULL);

-- 3. Enforce Unique mobile constraint for Active Customers only
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_mobile_key;
DROP INDEX IF EXISTS idx_customers_mobile_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile_active_unique 
ON customers (mobile) 
WHERE is_deleted = FALSE OR is_deleted IS NULL;

-- 4. Real-Time Customer Due & Advance Recalculation Trigger
CREATE OR REPLACE FUNCTION update_customer_balance_from_ledger()
RETURNS TRIGGER AS $$
DECLARE
    target_cust UUID := COALESCE(NEW.customer_id, OLD.customer_id);
    v_debits NUMERIC(12,2) := 0;
    v_credits NUMERIC(12,2) := 0;
    v_init NUMERIC(12,2) := 0;
    v_net NUMERIC(12,2) := 0;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_debits 
    FROM customer_ledger WHERE customer_id = target_cust AND entry_type = 'DEBIT';

    SELECT COALESCE(SUM(amount), 0) INTO v_credits 
    FROM customer_ledger WHERE customer_id = target_cust AND entry_type = 'CREDIT';

    SELECT COALESCE(initial_balance, 0) INTO v_init
    FROM customers WHERE id = target_cust;

    v_net := v_debits - v_credits + v_init;

    IF v_net >= 0 THEN
        UPDATE customers SET current_due = v_net, current_advance = 0.00, updated_at = now() WHERE id = target_cust;
    ELSE
        UPDATE customers SET current_due = 0.00, current_advance = ABS(v_net), updated_at = now() WHERE id = target_cust;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recalc_cust_balance ON customer_ledger;
CREATE TRIGGER trg_recalc_cust_balance
AFTER INSERT OR UPDATE OR DELETE ON customer_ledger
FOR EACH ROW
EXECUTE FUNCTION update_customer_balance_from_ledger();

-- 5. Auto-Purge function for customers in Recycle Bin over 30 days
CREATE OR REPLACE FUNCTION purge_expired_trash_customers()
RETURNS void AS $$
BEGIN
    DELETE FROM customers
    WHERE is_deleted = TRUE
      AND scheduled_deletion_at <= now();
END;
$$ LANGUAGE plpgsql;

-- 6. Add Wheat & Pickup fields to milling_bills if they don't exist
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS processing_type VARCHAR(50) DEFAULT 'OIL';
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS order_datetime TIMESTAMPTZ DEFAULT now();
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS pickup_datetime TIMESTAMPTZ;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS pickup_status VARCHAR(50) DEFAULT 'PENDING';
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS wheat_kg NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS flour_atta_kg NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS bran_chokar_kg NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS bag_charge NUMERIC(10,2) DEFAULT 0.00;

-- 7. Create or Update Electricity Readings Table (₹80/day fixed + ₹7.77/kWh)
CREATE TABLE IF NOT EXISTS electricity_readings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_date DATE,
    reading_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reading_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    days_elapsed INTEGER NOT NULL DEFAULT 1,
    billing_interval VARCHAR(20) NOT NULL DEFAULT 'DAILY',
    previous_reading NUMERIC(12,2) NOT NULL CHECK (previous_reading >= 0),
    current_reading NUMERIC(12,2) NOT NULL CHECK (current_reading >= previous_reading),
    units_consumed NUMERIC(12,2) GENERATED ALWAYS AS (current_reading - previous_reading) STORED,
    fixed_daily_cost NUMERIC(10,2) NOT NULL DEFAULT 80.00,
    unit_rate NUMERIC(10,2) NOT NULL DEFAULT 7.77,
    fixed_total_cost NUMERIC(12,2) NOT NULL DEFAULT 80.00,
    units_cost NUMERIC(12,2) GENERATED ALWAYS AS (ROUND((current_reading - previous_reading) * 7.77, 2)) STORED,
    final_total_cost NUMERIC(12,2),
    total_cost NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(80.00 + ((current_reading - previous_reading) * 7.77), 2)) STORED,
    meter_number VARCHAR(100) DEFAULT 'MAIN-METER-1',
    recorded_by VARCHAR(100) DEFAULT 'Owner',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS days_elapsed INTEGER DEFAULT 1;
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(20) DEFAULT 'DAILY';
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS fixed_total_cost NUMERIC(12,2) DEFAULT 80.00;
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS final_total_cost NUMERIC(12,2);

-- 8. Automatic Daily Fixed Electricity Charge Expense Insertion Trigger
CREATE OR REPLACE FUNCTION handle_electricity_expense()
RETURNS TRIGGER AS $$
DECLARE
    v_days INTEGER := COALESCE(NEW.days_elapsed, 1);
    v_fixed NUMERIC(12,2) := COALESCE(NEW.fixed_total_cost, v_days * 80.00);
    v_energy NUMERIC(12,2) := ROUND(COALESCE(NEW.units_consumed, 0) * 7.77, 2);
    v_total NUMERIC(12,2) := COALESCE(NEW.final_total_cost, v_fixed + v_energy);
BEGIN
    INSERT INTO expenses (
        expense_number,
        title,
        category,
        amount,
        payment_mode,
        paid_to,
        notes,
        expense_date
    ) VALUES (
        'EXP-ELEC-' || TO_CHAR(NEW.reading_date, 'YYYYMMDD') || '-' || SUBSTRING(NEW.id::TEXT, 1, 4),
        'Electricity: ' || v_days || ' Days Fixed (₹' || v_fixed || ') + ' || NEW.units_consumed || ' Units (₹' || v_energy || ')',
        'Electricity & Power',
        v_total,
        'CASH',
        'Electricity Board',
        'Interval: ' || COALESCE(NEW.billing_interval, 'DAILY') || ' (' || v_days || ' days @ ₹80/day = ₹' || v_fixed || ' auto-fixed charge). Meter: ' || NEW.previous_reading || ' to ' || NEW.current_reading || ' (' || NEW.units_consumed || ' kWh @ ₹7.77 = ₹' || v_energy || '). Total: ₹' || v_total,
        NEW.reading_date
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_electricity_expense ON electricity_readings;
CREATE TRIGGER trg_electricity_expense
AFTER INSERT ON electricity_readings
FOR EACH ROW
EXECUTE FUNCTION handle_electricity_expense();

-- 9. Create App Security & OTP Tables
CREATE TABLE IF NOT EXISTS app_security (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_name VARCHAR(150) DEFAULT 'Owner',
    admin_email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    pin_code VARCHAR(20),
    pin_required BOOLEAN DEFAULT FALSE,
    device_lock_enrolled BOOLEAN DEFAULT FALSE,
    use_biometrics BOOLEAN DEFAULT TRUE,
    is_configured BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE app_security ADD COLUMN IF NOT EXISTS pin_required BOOLEAN DEFAULT FALSE;
ALTER TABLE app_security ADD COLUMN IF NOT EXISTS device_lock_enrolled BOOLEAN DEFAULT FALSE;
ALTER TABLE app_security ADD COLUMN IF NOT EXISTS pin_code VARCHAR(20);

CREATE TABLE IF NOT EXISTS app_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    otp_code VARCHAR(10) NOT NULL,
    purpose VARCHAR(50) DEFAULT 'PASSWORD_RESET',
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 10. Add Wheat Service to Service Master
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM service_master WHERE service_code = 'SERV-03') THEN
        INSERT INTO service_master (service_name, service_code, service_category, oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes)
        VALUES ('Wheat / Gehu Pisai (Atta Chakki)', 'SERV-03', 'WHEAT', 'Wheat Flour', 3.00, 96.00, 4.00, 'Flour grinding rate per kg for whole wheat');
    END IF;
END $$;
