# Nexly — final repair build

## 1. Supabase

Open **SQL Editor → New query** and run the complete file:

`supabase-final.sql`

The script is a safe migration: it does not drop Nexly tables or users. It adds missing columns/tables, recreates Nexly-owned RPC functions with stable signatures, refreshes RLS policies, configures realtime, creates `nexly-media`, and adds the unread-message counter.

After the query finishes, the last result should contain:

`NEXLY_SCHEMA_READY`

## 2. Authentication

In **Authentication → Sign In / Providers → Email**:

- Email provider: ON
- Allow sign ups: ON
- Confirm Email: OFF

Nexly's UI uses only username/ID + password. It creates the technical Auth email internally.

## 3. VS Code

Open the folder that contains `package.json`, then run:

```powershell
npm install
npm run dev
```

Open the URL printed by Vite, normally:

`http://localhost:5173`

## 4. Deno / Edge Functions

The build does not require the old `username-login` Edge Function or Deno. You can leave the old deployed function in Supabase unused, but the client no longer depends on it.

## 5. Media

The app uses the public Supabase Storage bucket:

`nexly-media`

The SQL migration creates the bucket and upload/read/update/delete policies.

## 6. What was repaired

- block_user / unblock_user RPCs
- group member permissions RPC
- add/remove group members
- stable game match recording without duplicate 409 errors
- unread count reset when opening a chat
- group member list layout
- group avatar size
- dark/purple scrollbars and controls
- centered settings overlay
- dark/purple emoji picker and game UI
- group creation participant selection without the old explanatory text/search box
- existing-group member management
- safer WebM media playback URL (`?download=1` + preload=none)
- direct username/password auth without Deno


## Nexly v8 updates
- Group calls stay alive when participants reject/leave; the caller may remain alone and later members can join from the group call button.
- New groups can be created with a custom photo.
- Right-click/long-press opens quick reactions; the arrow expands the full emoji grid.
- Blocking is enforced at the database message boundary for the blocked account.
- Run the included `supabase-final.sql` in Supabase SQL Editor to apply the migration safely.
