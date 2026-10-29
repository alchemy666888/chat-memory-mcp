-- Test fixture only. chat-memory-agent owns the authoritative schema.
-- Do not treat this file as a migration or run it against Production.

DROP SCHEMA IF EXISTS chat_memory CASCADE;
CREATE SCHEMA chat_memory;
REVOKE ALL ON SCHEMA chat_memory FROM PUBLIC;

CREATE TABLE chat_memory.chat_memories (
  telegram_chat_id text PRIMARY KEY,
  summary_text text NOT NULL DEFAULT '',
  summary_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  summarized_at timestamptz,
  processing_token uuid,
  processing_lease_expires_at timestamptz,
  CONSTRAINT chat_memories_summary_length CHECK (char_length(summary_text) <= 8000),
  CONSTRAINT chat_memories_version_nonnegative CHECK (summary_version >= 0),
  CONSTRAINT chat_memories_lease_pair CHECK (
    (processing_token IS NULL AND processing_lease_expires_at IS NULL)
    OR (processing_token IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
  )
);

CREATE TABLE chat_memory.raw_messages (
  raw_message_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_chat_id text NOT NULL REFERENCES chat_memory.chat_memories (telegram_chat_id),
  event_key text NOT NULL,
  turn_id text NOT NULL,
  source_update_id bigint NOT NULL,
  source_message_id bigint,
  role text NOT NULL,
  content text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'non-process',
  processed_at timestamptz,
  processed_summary_version bigint,
  CONSTRAINT raw_messages_event_key UNIQUE (telegram_chat_id, event_key),
  CONSTRAINT raw_messages_role CHECK (role IN ('user', 'assistant')),
  CONSTRAINT raw_messages_status CHECK (status IN ('non-process', 'processed-completed')),
  CONSTRAINT raw_messages_content_nonempty CHECK (char_length(content) > 0),
  CONSTRAINT raw_messages_source_update_nonnegative CHECK (source_update_id >= 0),
  CONSTRAINT raw_messages_source_message_positive CHECK (
    source_message_id IS NULL OR source_message_id > 0
  ),
  CONSTRAINT raw_messages_processed_shape CHECK (
    (
      status = 'non-process'
      AND processed_at IS NULL
      AND processed_summary_version IS NULL
    )
    OR (
      status = 'processed-completed'
      AND processed_at IS NOT NULL
      AND processed_summary_version IS NOT NULL
      AND processed_summary_version > 0
    )
  )
);

CREATE INDEX raw_messages_pending_chrono_idx
  ON chat_memory.raw_messages (
    telegram_chat_id,
    occurred_at,
    source_update_id,
    raw_message_id
  )
  WHERE status = 'non-process';

CREATE INDEX raw_messages_pending_turn_idx
  ON chat_memory.raw_messages (telegram_chat_id, turn_id)
  WHERE status = 'non-process';

GRANT USAGE ON SCHEMA chat_memory TO chat_memory_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA chat_memory TO chat_memory_reader;
