# Time Tracking Worker Service

A dedicated Nest.js microservice that consumes raw time-tracking events from Kafka and persists them to TimescaleDB.

## Architecture

```
API Service (time-tracking-backend)
    │
    │ (publishes batches)
    ▼
Kafka Topic: raw-events
    │
    │ (consumes batches)
    ▼
Worker Service (this service)
    │
    │ (bulk inserts)
    ▼
TimescaleDB (raw_events hypertable)
```

## Features

- **Kafka Consumer**: Consumes event batches from the `raw-events` topic
- **TimescaleDB Integration**: Efficiently stores raw events in a hypertable for time-series queries
- **Idempotency**: Unique constraint prevents duplicate events if Kafka replays messages
- **Health Checks**: HTTP endpoints for monitoring service health
- **Error Handling**: Comprehensive logging and error recovery

## Prerequisites

1. **Kafka Broker** running and accessible
2. **PostgreSQL with TimescaleDB extension** installed
3. **Node.js** 18+ and npm

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and update with your configuration:

```bash
cp .env.example .env
```

Key variables:
- `KAFKA_BROKER`: Kafka broker address (e.g., `localhost:9092`)
- `TIMESCALE_DB_*`: TimescaleDB connection details
- `PORT`: HTTP server port for health checks (default: 3300)

### 3. Set Up TimescaleDB

#### Create Database

```sql
CREATE DATABASE timescale_db;
```

#### Enable TimescaleDB Extension

```sql
-- Connect to timescale_db
\c timescale_db

-- Run as superuser
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

#### Run Migration

The table structure is created by TypeORM. After the first run (with `synchronize: true` in development), convert it to a hypertable:

```bash
psql -U postgres -d timescale_db -f src/timescale/migrations/001-create-raw-events-hypertable.sql
```

Or manually:

```sql
SELECT create_hypertable('raw_events', 'time', if_not_exists => TRUE);
```

### 4. Start the Worker Service

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Health Checks

The service exposes HTTP endpoints for health monitoring:

- `GET /health` - Full health check (Kafka + TimescaleDB)
- `GET /health/liveness` - Simple liveness probe
- `GET /health/readiness` - Readiness probe (checks DB connection)

Example:

```bash
curl http://localhost:3300/health
```

## Testing

### 1. Start the Worker Service

```bash
npm run start:dev
```

### 2. Send Test Events

Use the API service to send test events (they will be published to Kafka):

```bash
# Using the API service's test script
curl -X POST http://localhost:4000/api/v1/events/batch \
  -H "Content-Type: application/json" \
  -H "x-device-id: test-device-123" \
  -H "x-tenant-id: 1" \
  -d '{
    "deviceId": "test-device-123",
    "batchTimestamp": 1234567890000,
    "events": [
      {
        "deviceId": "test-device-123",
        "timestamp": 1234567890000,
        "status": "active",
        "application": "VS Code",
        "title": "Working on backend",
        "duration": 60000
      }
    ]
  }'
```

### 3. Verify Events in TimescaleDB

```sql
SELECT * FROM raw_events ORDER BY time DESC LIMIT 10;
```

## Project Structure

```
src/
├── config/
│   └── configuration.ts          # Environment configuration
├── kafka/
│   ├── kafka.config.ts           # Kafka microservice config
│   └── kafka.module.ts           # Kafka module
├── events-consumer/
│   ├── events-consumer.service.ts # Main consumer service
│   ├── events-consumer.module.ts
│   └── interfaces/
│       └── raw-event-message.interface.ts
├── timescale/
│   ├── entities/
│   │   └── raw-event.entity.ts   # TimescaleDB entity
│   ├── migrations/
│   │   ├── 001-create-raw-events-hypertable.sql
│   │   └── README.md
│   ├── raw-events.repository.ts  # Persistence layer
│   └── timescale.module.ts
├── health/
│   ├── health.controller.ts      # Health check endpoints
│   └── health.module.ts
├── app.module.ts
└── main.ts                        # Bootstrap (Kafka microservice)
```

## Future Enhancements

### Aggregation Worker

A separate worker service will consume from `raw_events` and create aggregated 10-minute blocks:

- **Input**: Raw events from TimescaleDB
- **Output**: Aggregated events to `aggregated_events_10m` hypertable
- **Metrics**: Focused time, idle time, application usage, etc.

See `src/timescale/migrations/README.md` for planned schema.

### Dead Letter Queue

Failed messages can be sent to `raw-events-dlq` for manual inspection and replay.

### Monitoring

- Prometheus metrics for batch processing rates
- Grafana dashboards for ingestion latency
- Alerting on processing failures

## Troubleshooting

### Worker Not Consuming Messages

1. Check Kafka connectivity:
   ```bash
   # Verify broker is accessible
   telnet <KAFKA_BROKER> <PORT>
   ```

2. Check consumer group:
   ```bash
   # List consumer groups
   kafka-consumer-groups.sh --bootstrap-server <BROKER> --list
   ```

### TimescaleDB Connection Issues

1. Verify connection string in `.env`
2. Check PostgreSQL is running and TimescaleDB extension is installed
3. Verify database exists and user has permissions

### Duplicate Events

The unique constraint on `(tenant_id, device_id, timestamp)` prevents duplicates. If you see "duplicate key" warnings, this is expected when Kafka replays messages - the events are safely ignored.

## License

UNLICENSED
