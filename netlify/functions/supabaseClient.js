const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

let client = null;

function getSupabaseClient() {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.supabase_url || '').trim();
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.supabase_key || '').trim();

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[SupabaseClient] Warning: SUPABASE_URL or SUPABASE_ANON_KEY is not set in environment variables.');
    return null;
  }

  if (!client) {
    client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return client;
}

module.exports = {
  getSupabaseClient,
};
