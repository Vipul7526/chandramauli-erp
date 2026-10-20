-- ==================================================================================
-- CHANDRAMAULI MUSTARD OIL MILL & WHEAT ATTA CHAKKI - PRODUCTION SCHEMA
-- Location: Raghunathpur Bahaur, Mirzapur 231302
-- Phone: 8429774452 | Email: support.chandramauli@gmail.com
-- Developer: Prince Singh
-- ==================================================================================
-- Features:
-- 1. Unified Customers: One customer per unique mobile number (handles both Oil & Wheat)
-- 2. Mustard Oil Pelai & Wheat Pisai (Atta Chakki) order management
-- 3. Customer Order Date/Time & Pickup Date/Time tracking
-- 4. Machine Electricity Cost: ₹80/day fixed + ₹7.77 per kWh unit
-- 5. Customer Khata Ledger (Due & Advance tracking)
-- 6. Factory Expenses & Daily/Monthly P&L reporting
-- 7. App Security (Biometrics, PIN, Password & Email OTP reset)
-- ==================================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------------
-- 1. BRAND PROFILE (Exact Real Mill Details)
-- ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_name VARCHAR(255) NOT NULL DEFAULT 'Chandramauli Mustard Oil Mill',
    tagline VARCHAR(255) DEFAULT 'Kachi Ghani Mustard Oil & Pure Seed Extraction',
    phone VARCHAR(50) DEFAULT '8429774452',
    email VARCHAR(100) DEFAULT 'support.chandramauli@gmail.com',
    address TEXT DEFAULT 'Raghunathpur Bahaur,Mirzapur 231302',
    gstin VARCHAR(50) DEFAULT 'N/A',
    receipt_terms TEXT DEFAULT '1. Goods and oil once delivered will not be taken back. 2. Khali (Oil cake) / Chokar must be collected within 3 days. 3. Please verify weights before leaving counter.',
    currency_symbol VARCHAR(10) DEFAULT '₹',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO brand_profile (id, brand_name, tagline, phone, email, address, gstin, receipt_terms, currency_symbol)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Chandramauli Mustard Oil Mill',
    'Kachi Ghani Mustard Oil & Pure Seed Extraction',
    '8429774452',
    'support.chandramauli@gmail.com',
    'Raghunathpur Bahaur,Mirzapur 231302',
    'N/A',
    '1. Goods and oil once delivered will not be taken back. 2. Khali (Oil cake) / Chokar must be collected within 3 days. 3. Please verify weights before leaving counter.',
    '₹'
)
ON CONFLICT (id) DO UPDATE SET
    brand_name = EXCLUDED.brand_name,
    tagline = EXCLUDED.tagline,
    phone = EXCLUDED.phone,
    email = EXCLUDED.email,
    address = EXCLUDED.address,
    receipt_terms = EXCLUDED.receipt_terms,
    updated_at = now();

-- ----------------------------------------------------------------------------------
-- 2. UNIFIED CUSTOMERS TABLE (1 Customer per unique mobile number)
-- Unified for both Mustard Oil and Wheat Atta Chakki customers
-- ----------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS customer_serial_seq START WITH 1001 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    serial_number BIGINT NOT NULL DEFAULT nextval('customer_serial_seq') UNIQUE,
    serial_code VARCHAR(20) GENERATED ALWAYS AS ('CM-' || LPAD(serial_number::TEXT, 5, '0')) STORED,
    name VARCHAR(255) NOT NULL,
    mobile VARCHAR(20) NOT NULL UNIQUE, -- Strictly one customer per 1 mobile number
    village_or_city VARCHAR(255),
    address TEXT,
    initial_balance NUMERIC(12,2) DEFAULT 0.00,
    current_due NUMERIC(12,2) DEFAULT 0.00,
    current_advance NUMERIC(12,2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    scheduled_deletion_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure advance, due, and 30-day recycle bin columns exist if table was already created in earlier run
ALTER TABLE customers ADD COLUMN IF NOT EXISTS current_advance NUMERIC(12,2) DEFAULT 0.00;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS current_due NUMERIC(12,2) DEFAULT 0.00;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_search ON customers (name, mobile, serial_code);
CREATE INDEX IF NOT EXISTS idx_customers_is_deleted ON customers (is_deleted);
CREATE INDEX IF NOT EXISTS idx_customers_scheduled_deletion ON customers (scheduled_deletion_at);


-- ----------------------------------------------------------------------------------
-- 3. SERVICE MASTER (Crushing & Milling Rates per kg)
-- ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name VARCHAR(150) NOT NULL UNIQUE,
    service_code VARCHAR(50) UNIQUE,
    service_category VARCHAR(50) NOT NULL DEFAULT 'OIL', -- 'OIL' or 'WHEAT'
    oil_type VARCHAR(100) NOT NULL DEFAULT 'Mustard Oil (Sarson)',
    rate_per_kg NUMERIC(10,2) NOT NULL DEFAULT 6.00,
    expected_oil_percent NUMERIC(5,2) DEFAULT 34.00,
    expected_cake_percent NUMERIC(5,2) DEFAULT 63.00,
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure columns exist if table was already created in an earlier run
ALTER TABLE service_master ADD COLUMN IF NOT EXISTS service_category VARCHAR(50) DEFAULT 'OIL';

DO $$
BEGIN
    -- Yellow Mustard
    IF NOT EXISTS (SELECT 1 FROM service_master WHERE service_code = 'SERV-01') THEN
        INSERT INTO service_master (service_name, service_code, service_category, oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes)
        VALUES ('Yellow Mustard (Pili Sarson) Pelai', 'SERV-01', 'OIL', 'Mustard Oil', 6.00, 36.00, 61.00, 'Standard cold press extraction for yellow mustard')
        ON CONFLICT DO NOTHING;
    END IF;

    -- Black Mustard
    IF NOT EXISTS (SELECT 1 FROM service_master WHERE service_code = 'SERV-02') THEN
        INSERT INTO service_master (service_name, service_code, service_category, oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes)
        VALUES ('Black Mustard (Kali Sarson) Pelai', 'SERV-02', 'OIL', 'Mustard Oil', 5.50, 33.50, 63.50, 'Crushing rate per kg for black sarson')
        ON CONFLICT DO NOTHING;
    END IF;

    -- Wheat Grinding (SERV-03)
    IF EXISTS (SELECT 1 FROM service_master WHERE service_code = 'SERV-03') THEN
        UPDATE service_master 
        SET service_name = 'Wheat / Gehu Pisai (Atta Chakki)',
            service_category = 'WHEAT',
            oil_type = 'Wheat Flour',
            rate_per_kg = 3.00,
            expected_oil_percent = 96.00,
            expected_cake_percent = 4.00,
            notes = 'Flour grinding rate per kg for whole wheat'
        WHERE service_code = 'SERV-03';
    ELSE
        INSERT INTO service_master (service_name, service_code, service_category, oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes)
        VALUES ('Wheat / Gehu Pisai (Atta Chakki)', 'SERV-03', 'WHEAT', 'Wheat Flour', 3.00, 96.00, 4.00, 'Flour grinding rate per kg for whole wheat')
        ON CONFLICT DO NOTHING;
    END IF;

    -- Til Oil
    IF NOT EXISTS (SELECT 1 FROM service_master WHERE service_code = 'SERV-04') THEN
        INSERT INTO service_master (service_name, service_code, service_category, oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes)
        VALUES ('Sesame / Til Oil Extraction', 'SERV-04', 'OIL', 'Til Oil', 12.00, 42.00, 55.00, 'Crushing rate per kg for Sesame seeds')
        ON CONFLICT DO NOTHING;
    END IF;

    -- Groundnut Oil
    IF NOT EXISTS (SELECT 1 FROM service_master WHERE service_code = 'SERV-05') THEN
        INSERT INTO service_master (service_name, service_code, service_category, oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes)
        VALUES ('Groundnut (Mungfali) Oil Extraction', 'SERV-05', 'OIL', 'Groundnut Oil', 7.00, 40.00, 58.00, 'Crushing rate per kg for groundnut')
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- ----------------------------------------------------------------------------------
-- 4. MILLING & GRINDING ORDERS / BILLS (Mustard Oil & Wheat Atta Chakki)
-- Includes Order Date/Time and Pickup Date/Time
-- ----------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS bill_serial_seq START WITH 5001 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS milling_bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_number VARCHAR(50) NOT NULL UNIQUE,
    processing_type VARCHAR(50) NOT NULL DEFAULT 'OIL', -- 'OIL' or 'WHEAT'
    order_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),   -- Customer order arrival date & time
    pickup_datetime TIMESTAMPTZ,                         -- When customer picked up or estimated pickup
    pickup_status VARCHAR(50) DEFAULT 'PENDING',         -- 'PENDING', 'READY', 'PICKED_UP', 'DELIVERED'
    bill_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(20) NOT NULL,
    customer_serial_code VARCHAR(20) NOT NULL,
    service_id UUID REFERENCES service_master(id) ON DELETE SET NULL,
    oil_type VARCHAR(100) NOT NULL DEFAULT 'Mustard oil',
    
    -- Oil Milling Specifics
    sarson_kg NUMERIC(10,2) DEFAULT 0.00 CHECK (sarson_kg >= 0),
    extracted_oil_kg NUMERIC(10,2) DEFAULT 0.00 CHECK (extracted_oil_kg >= 0),
    oil_cake_kg NUMERIC(10,2) DEFAULT 0.00,
    oil_yield_percent NUMERIC(5,2) GENERATED ALWAYS AS (
        CASE WHEN sarson_kg > 0 THEN ROUND((extracted_oil_kg / sarson_kg) * 100, 2) ELSE 0 END
    ) STORED,

    -- Wheat (Gehu Pisai) Specifics
    wheat_kg NUMERIC(10,2) DEFAULT 0.00 CHECK (wheat_kg >= 0),
    flour_atta_kg NUMERIC(10,2) DEFAULT 0.00 CHECK (flour_atta_kg >= 0),
    bran_chokar_kg NUMERIC(10,2) DEFAULT 0.00,

    rate_per_kg NUMERIC(10,2) NOT NULL CHECK (rate_per_kg >= 0),
    milling_charge NUMERIC(12,2) GENERATED ALWAYS AS (
        ROUND((CASE WHEN processing_type = 'WHEAT' THEN wheat_kg ELSE sarson_kg END) * rate_per_kg, 2)
    ) STORED,

    tin_or_can_charge NUMERIC(10,2) DEFAULT 0.00,
    bag_charge NUMERIC(10,2) DEFAULT 0.00,
    other_charges NUMERIC(10,2) DEFAULT 0.00,
    discount NUMERIC(10,2) DEFAULT 0.00,
    total_amount NUMERIC(12,2) NOT NULL,
    advance_adjusted NUMERIC(12,2) DEFAULT 0.00,
    amount_paid NUMERIC(12,2) DEFAULT 0.00,
    balance_due NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    payment_mode VARCHAR(50) DEFAULT 'CASH',
    status VARCHAR(30) DEFAULT 'COMPLETED',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure wheat and pickup columns exist if table was already created in earlier run
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS processing_type VARCHAR(50) DEFAULT 'OIL';
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS order_datetime TIMESTAMPTZ DEFAULT now();
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS pickup_datetime TIMESTAMPTZ;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS pickup_status VARCHAR(50) DEFAULT 'PENDING';
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS wheat_kg NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS flour_atta_kg NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS bran_chokar_kg NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE milling_bills ADD COLUMN IF NOT EXISTS bag_charge NUMERIC(10,2) DEFAULT 0.00;

CREATE INDEX IF NOT EXISTS idx_milling_bills_customer ON milling_bills (customer_id);
CREATE INDEX IF NOT EXISTS idx_milling_bills_order_dt ON milling_bills (order_datetime);
CREATE INDEX IF NOT EXISTS idx_milling_bills_pickup_dt ON milling_bills (pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_milling_bills_type ON milling_bills (processing_type);

-- ----------------------------------------------------------------------------------
-- 5. UNIFIED CUSTOMER LEDGER (Khatabook Debit/Credit)
-- Automatically debits for bills (Oil/Wheat) and credits for payments received
-- ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    bill_id UUID REFERENCES milling_bills(id) ON DELETE SET NULL,
    entry_type VARCHAR(20) NOT NULL, -- 'DEBIT' (Bill charge) or 'CREDIT' (Payment)
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    payment_mode VARCHAR(50) DEFAULT 'CASH',
    balance_after NUMERIC(12,2) DEFAULT 0.00,
    description TEXT,
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger (customer_id, transaction_date DESC);

-- ----------------------------------------------------------------------------------
-- 6. MACHINE ELECTRICITY COST TRACKER
-- Fixed ₹80 per day + ₹7.77 per kWh unit
-- ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS electricity_readings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_date DATE,
    reading_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reading_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    days_elapsed INTEGER NOT NULL DEFAULT 1,
    billing_interval VARCHAR(20) NOT NULL DEFAULT 'DAILY', -- 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'
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

-- Safe migrations if table already exists
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS days_elapsed INTEGER DEFAULT 1;
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(20) DEFAULT 'DAILY';
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS fixed_total_cost NUMERIC(12,2) DEFAULT 80.00;
ALTER TABLE electricity_readings ADD COLUMN IF NOT EXISTS final_total_cost NUMERIC(12,2);

CREATE INDEX IF NOT EXISTS idx_electricity_date ON electricity_readings (reading_date DESC);

-- ----------------------------------------------------------------------------------
-- 7. FACTORY EXPENSES TABLE
-- Tracks operational expenses including electricity, wages, maintenance, spares
-- ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_number VARCHAR(50) UNIQUE,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL, 
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_mode VARCHAR(50) DEFAULT 'CASH',
    paid_to VARCHAR(255),
    voucher_no VARCHAR(100),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date);

-- Trigger: When electricity reading is entered, automatically record as an expense
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
        'Interval: ' || COALESCE(NEW.billing_interval, 'DAILY') || ' (' || v_days || ' days @ ₹80/day = ₹' || v_fixed || ' auto-fixed charge). Meter Reading: ' || NEW.previous_reading || ' to ' || NEW.current_reading || ' (' || NEW.units_consumed || ' kWh @ ₹7.77/kWh = ₹' || v_energy || '). Total: ₹' || v_total || '.',
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

-- ----------------------------------------------------------------------------------
-- 8. APP SECURITY & EMAIL OTP MANAGEMENT
-- Secure device screen lock / app password with email OTP recovery
-- ----------------------------------------------------------------------------------
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

-- Safe migrations for app_security
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

CREATE INDEX IF NOT EXISTS idx_app_otps ON app_otps (email, otp_code, is_used);

-- ----------------------------------------------------------------------------------
-- 9. AUTOMATED LEDGER & BALANCE TRIGGERS
-- ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recalc_customer_balance(cust_id UUID)
RETURNS VOID AS $$
DECLARE
    tot_debit NUMERIC(12,2) := 0.00;
    tot_credit NUMERIC(12,2) := 0.00;
    net_bal NUMERIC(12,2) := 0.00;
    init_bal NUMERIC(12,2) := 0.00;
BEGIN
    SELECT COALESCE(initial_balance, 0.00) INTO init_bal FROM customers WHERE id = cust_id;

    SELECT COALESCE(SUM(amount), 0.00) INTO tot_debit 
    FROM customer_ledger 
    WHERE customer_id = cust_id AND entry_type = 'DEBIT';

    SELECT COALESCE(SUM(amount), 0.00) INTO tot_credit 
    FROM customer_ledger 
    WHERE customer_id = cust_id AND entry_type = 'CREDIT';

    net_bal := init_bal + tot_debit - tot_credit;

    IF net_bal >= 0 THEN
        UPDATE customers 
        SET current_due = net_bal, current_advance = 0.00, updated_at = now() 
        WHERE id = cust_id;
    ELSE
        UPDATE customers 
        SET current_due = 0.00, current_advance = ABS(net_bal), updated_at = now() 
        WHERE id = cust_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION handle_milling_bill_insert()
RETURNS TRIGGER AS $$
DECLARE
    desc_text TEXT;
BEGIN
    IF NEW.processing_type = 'WHEAT' THEN
        desc_text := 'Wheat Pisai #' || NEW.bill_number || ' - ' || NEW.wheat_kg || 'kg Gehu';
    ELSE
        desc_text := 'Milling Slip #' || NEW.bill_number || ' - ' || NEW.sarson_kg || 'kg ' || NEW.oil_type;
    END IF;

    -- 1. Debit customer for bill amount
    INSERT INTO customer_ledger (
        customer_id,
        bill_id,
        entry_type,
        amount,
        payment_mode,
        description,
        transaction_date
    ) VALUES (
        NEW.customer_id,
        NEW.id,
        'DEBIT',
        NEW.total_amount,
        NEW.payment_mode,
        desc_text,
        NEW.order_datetime
    );

    -- 2. Credit customer if payment made
    IF NEW.amount_paid > 0 THEN
        INSERT INTO customer_ledger (
            customer_id,
            bill_id,
            entry_type,
            amount,
            payment_mode,
            description,
            transaction_date
        ) VALUES (
            NEW.customer_id,
            NEW.id,
            'CREDIT',
            NEW.amount_paid,
            NEW.payment_mode,
            'Payment received for Order #' || NEW.bill_number,
            NEW.order_datetime
        );
    END IF;

    PERFORM recalc_customer_balance(NEW.customer_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_milling_bill_insert ON milling_bills;
CREATE TRIGGER trg_milling_bill_insert
AFTER INSERT ON milling_bills
FOR EACH ROW
EXECUTE FUNCTION handle_milling_bill_insert();

CREATE OR REPLACE FUNCTION handle_ledger_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalc_customer_balance(OLD.customer_id);
    ELSE
        PERFORM recalc_customer_balance(NEW.customer_id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_change ON customer_ledger;
CREATE TRIGGER trg_ledger_change
AFTER INSERT OR UPDATE OR DELETE ON customer_ledger
FOR EACH ROW
EXECUTE FUNCTION handle_ledger_change();

-- Auto-Purge function for customers in Recycle Bin over 30 days
CREATE OR REPLACE FUNCTION purge_expired_trash_customers()
RETURNS void AS $$
BEGIN
    DELETE FROM customers
    WHERE is_deleted = TRUE
      AND scheduled_deletion_at <= now();
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------------
-- 10. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------------
ALTER TABLE brand_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE milling_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE electricity_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_otps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all backend brand" ON brand_profile;
CREATE POLICY "Allow all backend brand" ON brand_profile FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend customers" ON customers;
CREATE POLICY "Allow all backend customers" ON customers FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend service_master" ON service_master;
CREATE POLICY "Allow all backend service_master" ON service_master FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend milling_bills" ON milling_bills;
CREATE POLICY "Allow all backend milling_bills" ON milling_bills FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend customer_ledger" ON customer_ledger;
CREATE POLICY "Allow all backend customer_ledger" ON customer_ledger FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend electricity" ON electricity_readings;
CREATE POLICY "Allow all backend electricity" ON electricity_readings FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend expenses" ON expenses;
CREATE POLICY "Allow all backend expenses" ON expenses FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend app_security" ON app_security;
CREATE POLICY "Allow all backend app_security" ON app_security FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all backend app_otps" ON app_otps;
CREATE POLICY "Allow all backend app_otps" ON app_otps FOR ALL USING (true) WITH CHECK (true);

