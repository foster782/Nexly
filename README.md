# Nexly — release build

React + Vite + Supabase messenger.

## What is included
- Username + password only (no email confirmation in the UI).
- Chats with friends, ID search only in Chats.
- Groups with all current friends preselected when creating a group.
- Realtime typing, pinned messages, replies, forwarding.
- Photo/video/file/GIF/voice/video-circle media through `nexly-media`.
- User blocking and blocked-user settings.
- Automatic/manual presence: auto, online, away, do-not-disturb, offline.
- 1:1 audio/video calls and group calls up to 6 participants.
- Incoming/outgoing call sounds in `public/sounds`.
- `/play` game invitations and 3 lightweight games: Nexly Racing, Tic-Tac-Toe and Rock-Paper-Scissors.
- Game history in Settings.
- Light/dark theme and responsive desktop/mobile UI.

## Supabase setup
1. Open Supabase SQL Editor.
2. Run `supabase-final.sql` once. It is a non-destructive migration: it creates missing tables/columns and policies without dropping existing chats/users.
3. Authentication -> Sign In / Providers -> Email: enable Email provider and turn **Confirm Email OFF**. Nexly uses a technical internal email only for Supabase Auth; users only see their username.
4. The `nexly-media` public storage bucket is created by the SQL.

## Run in VS Code
```powershell
npm install
npm run dev
```
Open the Vite Local URL (normally `http://localhost:5173`).

## Supabase config
`public/config.js` is already filled for the current Nexly Supabase project. The browser-facing value is the publishable key. Never put a `sb_secret_*` or `service_role` key in this file.

## Calls
WebRTC uses public STUN servers. Cross-network calls can still require a TURN relay on restrictive NATs/firewalls.
Browser notifications require notification permission. Fully closed-tab push notifications need a push provider/VAPID backend and are not claimed as fully configured in this client-only build.
