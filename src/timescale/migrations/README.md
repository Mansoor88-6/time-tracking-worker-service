# TimescaleDB Migrations

This directory contains SQL migrations for setting up TimescaleDB hypertables.

## Prerequisites

1. **PostgreSQL with TimescaleDB extension installed**
   ```sql
   -- Run as superuser
   CREATE EXTENSION IF NOT EXISTS timescaledb;
   ```

2. **Database created**
   ```sql
   CREATE DATABASE timescale_db;
   ```

## Running Migrations

### Option 1: Using psql

```bash
psql -U postgres -d timescale_db -f src/timescale/migrations/001-create-raw-events-hypertable.sql
```

### Option 2: Using TypeORM CLI (if configured)

```bash
npm run migration:run
```

## Migration Files

### 001-create-raw-events-hypertable.sql

Creates the `raw_events` hypertable for storing raw time-tracking events.

**What it does:**
- Converts the `raw_events` table to a TimescaleDB hypertable
- Adds indexes for common query patterns
- Verifies hypertable creation

**Note:** The table structure itself is created by TypeORM based on `RawEventEntity`. This migration only converts it to a hypertable.

## Future Migrations

### Planned: aggregated_events_10m hypertable

For future aggregation workers, we plan to create:

```sql
CREATE TABLE aggregated_events_10m (
  time TIMESTAMPTZ NOT NULL,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  focused_duration_ms BIGINT DEFAULT 0,
  idle_duration_ms BIGINT DEFAULT 0,
  away_duration_ms BIGINT DEFAULT 0,
  offline_duration_ms BIGINT DEFAULT 0,
  application_count INTEGER DEFAULT 0,
  project_id VARCHAR(255),
  PRIMARY KEY (time, tenant_id, user_id, device_id)
);

SELECT create_hypertable('aggregated_events_10m', 'time');
```

This will be implemented when the aggregation worker service is built.
