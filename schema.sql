-- Dispatch schema. Safe to re-run while the edition is being rebuilt.

DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS articles;
DROP TABLE IF EXISTS meta;

CREATE TABLE articles (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  source      TEXT NOT NULL,
  published   TEXT,
  summary     TEXT,
  ingested_at TEXT NOT NULL
);

CREATE TABLE chunks (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  text       TEXT NOT NULL
);

CREATE INDEX idx_chunks_article ON chunks (article_id);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
