#!/bin/sh
set -eu

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_memory_owner') THEN
    CREATE ROLE chat_memory_owner LOGIN PASSWORD 'chat-memory-owner-test';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_memory_reader') THEN
    CREATE ROLE chat_memory_reader LOGIN PASSWORD 'chat-memory-reader-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
SQL

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'chat_memory_mcp_test'" | grep -q 1 \
  || sudo -u postgres createdb -O chat_memory_owner chat_memory_mcp_test

sudo -u postgres psql -d chat_memory_mcp_test -v ON_ERROR_STOP=1 <<'SQL'
REVOKE ALL ON SCHEMA public FROM chat_memory_reader;
GRANT pg_read_all_stats TO chat_memory_owner;
SQL
