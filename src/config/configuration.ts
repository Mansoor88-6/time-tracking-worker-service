export default () => ({
  kafka: {
    broker: process.env.KAFKA_BROKER || '51.91.156.207:9092',
    clientId: process.env.KAFKA_CLIENT_ID_WORKER || 'time-tracking-worker',
    groupId: process.env.KAFKA_GROUP_ID_WORKER || 'raw-events-worker',
    topicRawEvents: process.env.KAFKA_TOPIC_RAW_EVENTS || 'raw-events',
  },
  timescale: {
    host: process.env.TIMESCALE_DB_HOST || 'localhost',
    port: parseInt(process.env.TIMESCALE_DB_PORT || '5432', 10),
    username: process.env.TIMESCALE_DB_USER || 'postgres',
    password: process.env.TIMESCALE_DB_PASSWORD || 'postgres',
    database: process.env.TIMESCALE_DB_NAME || 'timescale_db',
  },
  worker: {
    internalKey: process.env.WORKER_INTERNAL_KEY || 'change-me-in-production',
  },
});
