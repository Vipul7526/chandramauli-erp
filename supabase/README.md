# Supabase Database Setup for Chandramauli Oil ERP

## Quick Setup Guide

1. Log into your [Supabase Dashboard](https://supabase.com/dashboard).
2. Create a new project (e.g. `chandramauli-oil-erp`).
3. In the left navigation, click on **SQL Editor**.
4. Click **New query**.
5. Copy all the contents of `supabase_schema.sql` and paste it into the editor.
6. Click **Run** (or `Ctrl+Enter`).

## What this schema creates:

- **`customers` table**: Includes auto-incrementing serial sequence generating codes like `CM-01001`, `CM-01002`. Tracks `current_due` and `current_advance`.
- **`service_master` table**: Manages crushing services (Mustard Oil, Til, Groundnut) with `rate_per_kg` and expected oil & cake yield percentages.
- **`milling_bills` table**: Records extraction slips ("Parchi") with Sarson kg, Extracted oil kg, Oil cake kg, Rate per kg, Total milling charge, Amount paid, and Balance due.
- **`customer_ledger` table**: Complete Khatabook debit/credit transaction history for each customer.
- **`expenses` table**: Mill expenses categorized by Electricity, Wages, Maintenance, Tins, Packaging, etc.
- **Automated Triggers**: Whenever a bill is entered, it automatically creates ledger debit/credit entries and updates customer balance.
- **`view_customer_disambiguation`**: Quick query to detect if 2 or more customers share duplicate names and returns their unique serial codes.
- **`view_daily_profit_loss`**: Real-time aggregated report of Sarson crushed, oil produced, revenue, expenses, and net profit.
