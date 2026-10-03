# Nexly — current fixes

1. Run `supabase-final.sql` in the Nexly Supabase project's SQL Editor.
2. In Authentication → Sign In / Providers → Email, keep Email provider ON, Allow sign ups ON, Confirm Email OFF.
3. No Deno / Edge Function is required for username login.
4. From the project folder run `npm install`, then `npm run dev`.
5. Open the Vite URL, usually http://localhost:5173.

The SQL migration adds the fields/tables required by the current UI: status_mode, last_seen, phone_verified, blocked_users, game_invites, game_matches, plus Storage bucket nexly-media and Realtime policies.
