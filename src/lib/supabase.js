import { createClient } from '@supabase/supabase-js'

// Public project credentials — safe to ship in client code. RLS is the real
// security boundary; this is the PUBLISHABLE key, never the service_role key.
// Env vars (.env.local) override for local dev if present.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://rstmlalwjhyeflbmlhfd.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_l6ZIIDQyTJHeXvpywYnseA_tOu5VUcI'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
