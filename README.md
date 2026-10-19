# Netlify Backend for Chandramauli Oil ERP

This serverless backend connects the Chandramauli Flutter mobile app (`com.chandramauli.erp`) to your Supabase PostgreSQL database.

## Deployment Instructions

### Method 1: Using Netlify Dashboard (Drag & Drop or Git)
1. Log in to [Netlify](https://app.netlify.com).
2. Create a new site from your Git repository OR deploy manually.
3. In Netlify Dashboard, go to **Site configuration** &rarr; **Environment variables**.
4. Add the following variables:
   - `SUPABASE_URL`: Your Supabase Project URL (e.g., `https://yourproject.supabase.co`)
   - `SUPABASE_ANON_KEY`: Your Supabase Anon Key (or `SUPABASE_SERVICE_ROLE_KEY`)
5. Save and trigger a deployment.
6. Once deployed, copy your site URL (e.g., `https://your-site.netlify.app/api`).

### Method 2: Using Netlify CLI
```bash
cd netlify_backend
npm install
netlify link
netlify env:set SUPABASE_URL "https://your-project.supabase.co"
netlify env:set SUPABASE_ANON_KEY "your-anon-key"
netlify deploy --prod
```

## API Endpoints Reference

- `GET  /api/health` - Server & Supabase connectivity status
- `GET  /api/customers?search={query}` - Search customers; includes `disambiguationRequired` flag when multiple customers share the same name
- `POST /api/customers` - Register new customer (auto-assigns `CM-XXXXX` serial number)
- `GET  /api/services` - List crushing services and rate per kg
- `POST /api/services` - Create/update service rate per kg
- `POST /api/bills` - Create extraction bill / parchi and auto-sync to customer ledger
- `GET  /api/bills?date=YYYY-MM-DD` - Filter extraction bills by date / month / year
- `GET  /api/ledger?customer_id={id}` - Customer transaction ledger (Khatabook format)
- `POST /api/ledger` - Record payment received or debit
- `GET  /api/expenses` - Factory expenses
- `POST /api/expenses` - Record new factory expense
- `GET  /api/reports/profit-loss?month={m}&year={y}` - Detailed profit and loss report
