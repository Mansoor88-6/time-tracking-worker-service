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
    /** Extra comma-separated app names (case-insensitive) merged with loginwindow + LockApp */
    systemIdleAppDenylist: process.env.SYSTEM_IDLE_APP_DENYLIST ?? '',
  },
  backendDb: {
    host: process.env.BACKEND_DB_HOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.BACKEND_DB_PORT || process.env.DB_PORT || '5432', 10),
    username: process.env.BACKEND_DB_USER || process.env.DB_USERNAME || 'postgres',
    password: process.env.BACKEND_DB_PASSWORD || process.env.DB_PASSWORD || 'postgres',
    database: process.env.BACKEND_DB_NAME || process.env.DB_NAME || 'time-tracking',
  },
});
