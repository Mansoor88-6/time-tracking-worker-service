-- Migration: Create raw_events hypertable for TimescaleDB
-- Run this migration after creating the database and enabling the TimescaleDB extension
--
-- Prerequisites:
--   1. PostgreSQL with TimescaleDB extension installed
--   2. CREATE EXTENSION IF NOT EXISTS timescaledb; (run as superuser)
--
-- Usage:
--   psql -U postgres -d timescale_db -f src/timescale/migrations/001-create-raw-events-hypertable.sql

-- Create the raw_events table if it doesn't exist
-- Note: TypeORM will create the table structure, but we need to convert it to a hypertable
-- This script assumes the table structure matches RawEventEntity

-- Convert the table to a hypertable (partitioned by time column)
-- This enables TimescaleDB's time-series optimizations
SELECT create_hypertable('raw_events', 'time', if_not_exists => TRUE);

-- Add additional indexes for common query patterns
-- (TypeORM will create indexes from entity decorators, but we can add more here if needed)

-- Index for querying by project_id and time range
CREATE INDEX IF NOT EXISTS idx_raw_events_project_time 
ON raw_events (project_id, time) 
WHERE project_id IS NOT NULL;

-- Index for querying by status and time range
CREATE INDEX IF NOT EXISTS idx_raw_events_status_time 
ON raw_events (status, time);

-- Verify hypertable creation
SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'raw_events';
