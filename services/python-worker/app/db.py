# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
"""Postgres helper. Open a connection and write the job result."""
import psycopg

from app.config import Config


def connect(cfg: Config) -> psycopg.Connection:
    # autocommit so each write hits the WAL for Debezium right away
    return psycopg.connect(cfg.pg_conninfo(), autocommit=True)


def is_worker_available(conn: psycopg.Connection) -> bool:
    """Read the demo control flag. false means pause. defaults to available on error."""
    try:
        row = conn.execute("SELECT available FROM worker_control WHERE id = 1").fetchone()
        return bool(row[0]) if row else True
    except Exception:  # noqa: BLE001
        return True


def heartbeat(conn: psycopg.Connection, worker_id: str) -> None:
    """Record that this worker is alive, so the UI can count ready workers."""
    conn.execute(
        "INSERT INTO worker_heartbeat (id, last_seen) VALUES (%s, now()) "
        "ON CONFLICT (id) DO UPDATE SET last_seen = now()",
        (worker_id,),
    )


def mark_processing(conn: psycopg.Connection, job_id: str) -> None:
    """Mark the job processing when the worker picks it up, before the work runs."""
    conn.execute(
        "UPDATE jobs SET status = 'processing', updated_at = now() WHERE id = %s",
        (job_id,),
    )


def write_result(conn: psycopg.Connection, job_id: str, payload: str, result: str, owner: str) -> None:
    """Mark the job completed. ON CONFLICT covers a missing row. owner is not overwritten."""
    conn.execute(
        """
        INSERT INTO jobs (id, payload, owner, status, result, updated_at)
        VALUES (%s, %s, %s, 'completed', %s, now())
        ON CONFLICT (id) DO UPDATE
            SET status = 'completed',
                result = EXCLUDED.result,
                updated_at = now()
        """,
        (job_id, payload, owner, result),
    )


def mark_failed(conn: psycopg.Connection, job_id: str, payload: str, owner: str, error: str) -> None:
    """Mark a job failed. the message also goes to the DLQ."""
    conn.execute(
        """
        INSERT INTO jobs (id, payload, owner, status, result, updated_at)
        VALUES (%s, %s, %s, 'failed', %s, now())
        ON CONFLICT (id) DO UPDATE
            SET status = 'failed',
                result = EXCLUDED.result,
                updated_at = now()
        """,
        (job_id, payload, owner, error),
    )
