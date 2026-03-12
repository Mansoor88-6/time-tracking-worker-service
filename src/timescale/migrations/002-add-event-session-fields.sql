-- Migration: Add event-driven session tracking fields to raw_events table
-- Run this migration after the initial hypertable creation
--
-- Prerequisites:
--   1. raw_events table must exist (from 001-create-raw-events-hypertable.sql)
--   2. TimescaleDB extension must be enabled
--
-- Usage:
--   psql -U postgres -d timescale_db -f src/timescale/migrations/002-add-event-session-fields.sql

-- Add new columns for event-driven session tracking
ALTER TABLE raw_events
ADD COLUMN IF NOT EXISTS source VARCHAR(20),
ADD COLUMN IF NOT EXISTS tab_id INTEGER,
ADD COLUMN IF NOT EXISTS window_id INTEGER,
ADD COLUMN IF NOT EXISTS sequence BIGINT,
ADD COLUMN IF NOT EXISTS start_time BIGINT,
ADD COLUMN IF NOT EXISTS end_time BIGINT;

-- Add indexes for efficient querying on new fields
-- Index for querying by source (browser vs app)
CREATE INDEX IF NOT EXISTS idx_raw_events_source_time 
ON raw_events (source, time) 
WHERE source IS NOT NULL;

-- Index for querying by sequence (for debugging/ordering)
CREATE INDEX IF NOT EXISTS idx_raw_events_sequence 
ON raw_events (sequence) 
WHERE sequence IS NOT NULL;

-- Index for querying browser events by tab/window
CREATE INDEX IF NOT EXISTS idx_raw_events_tab_window 
ON raw_events (tab_id, window_id, time) 
WHERE tab_id IS NOT NULL AND window_id IS NOT NULL;

-- Index for querying by time range using start_time/end_time
CREATE INDEX IF NOT EXISTS idx_raw_events_start_end_time 
ON raw_events (start_time, end_time) 
WHERE start_time IS NOT NULL AND end_time IS NOT NULL;

-- Verify columns were added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'raw_events' 
AND column_name IN ('source', 'tab_id', 'window_id', 'sequence', 'start_time', 'end_time')
ORDER BY column_name;
