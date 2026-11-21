-- Fictional probe schema applied only to the approved test D1 database.
CREATE TABLE IF NOT EXISTS probe_oauth_flows(owner TEXT PRIMARY KEY,state_hash TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS probe_connections(owner TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,payload TEXT,lease INTEGER NOT NULL DEFAULT 0,prior_status TEXT,plan_id TEXT);
CREATE TABLE IF NOT EXISTS probe_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS probe_handoffs(id_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,challenge_hash TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS probe_browser_sessions(id_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,csrf_hash TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS probe_owner_epochs(owner TEXT PRIMARY KEY,epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS probe_assertions(test TEXT PRIMARY KEY,passed INTEGER NOT NULL CHECK(passed=1));
