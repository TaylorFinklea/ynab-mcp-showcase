CREATE TABLE IF NOT EXISTS fictional_probe (id TEXT PRIMARY KEY CHECK(id='fictional-only'), value TEXT NOT NULL CHECK(value='not-connected'));
INSERT OR IGNORE INTO fictional_probe(id,value) VALUES ('fictional-only','not-connected');
