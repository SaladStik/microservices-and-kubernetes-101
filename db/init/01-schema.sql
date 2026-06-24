-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
-- Demo schema. jobs is the system of record, Debezium emits CDC from its WAL.

CREATE TABLE IF NOT EXISTS jobs (
    id          UUID PRIMARY KEY,
    payload     TEXT        NOT NULL,
    owner       TEXT        NOT NULL DEFAULT 'anonymous', -- which user submitted it
    status      TEXT        NOT NULL DEFAULT 'pending',
    result      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- powers the job history view
CREATE INDEX IF NOT EXISTS jobs_owner_created_idx ON jobs (owner, created_at DESC);

-- explicit publication for Debezium pgoutput, REPLICA IDENTITY FULL carries the before row
ALTER TABLE jobs REPLICA IDENTITY FULL;

DROP PUBLICATION IF EXISTS orbit_publication;
CREATE PUBLICATION orbit_publication FOR TABLE jobs;

-- flag for the service down demo, available false means the worker pauses
-- kept out of the publication so toggling makes no CDC noise
CREATE TABLE IF NOT EXISTS worker_control (
    id        INT PRIMARY KEY DEFAULT 1,
    available BOOLEAN NOT NULL DEFAULT true,  -- service up or down
    autoscale BOOLEAN NOT NULL DEFAULT true,  -- autoscaling on or off
    CONSTRAINT worker_control_singleton CHECK (id = 1)
);
INSERT INTO worker_control (id, available, autoscale) VALUES (1, true, true) ON CONFLICT (id) DO NOTHING;

-- each worker heartbeats here, so the UI can show how many are ready to process
-- not in the publication, so heartbeats make no CDC noise
CREATE TABLE IF NOT EXISTS worker_heartbeat (
    id        TEXT PRIMARY KEY,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
