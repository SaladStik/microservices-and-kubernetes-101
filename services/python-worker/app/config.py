# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
"""Config helper. Import Config and call from_env."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    # Kafka
    bootstrap: str
    job_requests_topic: str
    dlq_topic: str
    group_id: str

    # Postgres
    pg_host: str
    pg_port: str
    pg_user: str
    pg_password: str
    pg_database: str

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            bootstrap=os.environ.get("KAFKA_BOOTSTRAP", "kafka:9092"),
            job_requests_topic=os.environ.get("JOB_REQUESTS_TOPIC", "job.requests"),
            dlq_topic=os.environ.get("DLQ_TOPIC", "job.requests.dlq"),
            group_id=os.environ.get("KAFKA_GROUP_ID", "python-worker"),
            pg_host=os.environ.get("PGHOST", "postgres"),
            pg_port=os.environ.get("PGPORT", "5432"),
            pg_user=os.environ.get("PGUSER", "orbit"),
            pg_password=os.environ.get("PGPASSWORD", "orbit"),
            pg_database=os.environ.get("PGDATABASE", "orbit"),
        )

    def kafka_consumer_config(self) -> dict:
        """confluent-kafka consumer settings."""
        return {
            "bootstrap.servers": self.bootstrap,
            "group.id": self.group_id,
            "auto.offset.reset": "earliest",
            # manual commit, only advance the offset after a message is handled
            "enable.auto.commit": False,
            # detect a dead worker fast, so scale down reassigns its partitions in
            # seconds instead of the 45 second default. otherwise jobs look stuck
            "session.timeout.ms": 10000,
            "heartbeat.interval.ms": 3000,
        }

    def kafka_producer_config(self) -> dict:
        """confluent-kafka producer settings, used only for the DLQ."""
        return {"bootstrap.servers": self.bootstrap}

    def pg_conninfo(self) -> str:
        """libpq connection string for psycopg."""
        return (
            f"host={self.pg_host} port={self.pg_port} "
            f"user={self.pg_user} password={self.pg_password} "
            f"dbname={self.pg_database}"
        )
