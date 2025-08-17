# Love Letter — Next.js + Supabase (Single App)

A production-friendly refactor of the Love Letter game using a **single Next.js app** with **Supabase** for durable state and **Realtime** updates. Works on Vercel (no custom servers).

## Quick Start

1. **Create a Supabase project** and copy:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_URL` (same as above)
   - `SUPABASE_SERVICE_ROLE_KEY` (server-side only!)

2. **Create table** (SQL):
   ```sql
   create table if not exists public.games (
     code text primary key,
     state jsonb not null,
     updated_at timestamp with time zone default now()
   );
   -- Enable Realtime
   alter publication supabase_realtime add table public.games;