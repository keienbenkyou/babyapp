-- ================================================================
-- BabyTrack Supabase Schema
-- Run this in the Supabase SQL Editor to set up the backend tables.
-- ================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Logs table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs (
  id             TEXT PRIMARY KEY,
  household_id   TEXT NOT NULL,
  baby_id        TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('sleep', 'feed', 'diaper', 'note')),
  subtype        TEXT,
  start_at       TIMESTAMPTZ NOT NULL,
  end_at         TIMESTAMPTZ,
  amount         NUMERIC,
  quality        SMALLINT CHECK (quality BETWEEN 1 AND 5),
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ,
  edited_by      TEXT
);

-- Index for real-time filtering by household
CREATE INDEX IF NOT EXISTS idx_logs_household ON logs (household_id);
CREATE INDEX IF NOT EXISTS idx_logs_household_updated ON logs (household_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_logs_baby_start ON logs (baby_id, start_at);

-- ── Row Level Security ─────────────────────────────────────────
-- (Optional: if you use anon key only, this provides basic scoping)
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated or anon users
-- (Simplified: for a private family app with anon key, this is sufficient.
--  For production, you'd add auth and per-household policies.)
CREATE POLICY "Allow all for anon" ON logs
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── Babies table (optional: sync baby profiles) ────────────────
CREATE TABLE IF NOT EXISTS babies (
  id             TEXT PRIMARY KEY,
  household_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  dob            DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_babies_household ON babies (household_id);

ALTER TABLE babies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon babies" ON babies
  FOR ALL USING (true) WITH CHECK (true);

-- ── Enable Realtime ────────────────────────────────────────────
-- Go to Supabase Dashboard → Database → Replication and enable
-- the 'logs' table for Realtime, OR run:
ALTER PUBLICATION supabase_realtime ADD TABLE logs;

-- ================================================================
-- Setup instructions:
-- 1. Create a free Supabase project at https://supabase.com
-- 2. Go to SQL Editor, paste this entire file, and click "Run"
-- 3. Copy your project URL and anon key from Settings → API
-- 4. Enter them in BabyTrack Settings → Partner Sync
-- 5. Share the Household ID with your partner (or scan QR)
-- ================================================================
