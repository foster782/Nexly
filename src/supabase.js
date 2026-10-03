import { createClient } from '@supabase/supabase-js'

const cfg = window.NEXLY_CONFIG || {}
const url = cfg.supabaseUrl
const key = cfg.supabasePublishableKey

if (!url || !key || url.includes('YOUR_PROJECT_REF') || key.includes('YOUR_PUBLISHABLE_KEY')) {
  throw new Error('Открой public/config.js и укажи Supabase URL и Publishable key')
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  },
  realtime: { params: { eventsPerSecond: 20 } }
})

export const usernameEmail = (username) => `${String(username).trim().toLowerCase()}@id.nexly.local`
