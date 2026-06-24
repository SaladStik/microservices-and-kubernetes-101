// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// Config helper. Never read process.env outside this file.
export const config = {
  port: Number(process.env.PORT || 4000),

  // Postgres read model. Records the queued state and reads job history back.
  pg: {
    host: process.env.PGHOST || "postgres",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "orbit",
    password: process.env.PGPASSWORD || "orbit",
    database: process.env.PGDATABASE || "orbit",
  },

  kafka: {
    clientId: "node-gateway",
    brokers: (process.env.KAFKA_BOOTSTRAP || "kafka:9092").split(","),
    // gateway produces job requests here, the worker consumes
    jobRequestsTopic: process.env.JOB_REQUESTS_TOPIC || "job.requests",
    // Debezium produces row changes here, the gateway consumes for CDC
    cdcTopic: process.env.CDC_TOPIC || "orbit.public.jobs",
    cdcGroupId: "node-gateway-cdc",
  },
};
