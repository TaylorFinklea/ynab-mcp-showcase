-- Initial schema for the ynab-mcp D1 database. Applied by you with `npx wrangler d1 migrations apply ynab-mcp --remote -c mcp/wrangler.json` (see mcp/SETUP.md); tests apply it to a local database.
CREATE TABLE oauth_flows(owner TEXT PRIMARY KEY,state_hash TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE connections(owner TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,payload TEXT,lease INTEGER NOT NULL DEFAULT 0,prior_status TEXT,plan_id TEXT);
CREATE TABLE owner_epochs(owner TEXT PRIMARY KEY,epoch INTEGER NOT NULL DEFAULT 0);
