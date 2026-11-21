import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const TEST_DATABASE_ID = "22222222-2222-4222-8222-222222222222";
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("./migrations");
      return {
        miniflare: {
          d1Databases: { DB: TEST_DATABASE_ID },
          kvNamespaces: ["OAUTH_KV"],
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          compatibilityDate: "2026-10-30",
          bindings: {
            PUBLIC_ORIGIN: "https://fictional.example",
            YNAB_CLIENT_ID: "fictional-client",
            YNAB_CLIENT_SECRET: "fictional-client-secret",
            VAULT_KEY: b64url(crypto.getRandomValues(new Uint8Array(32))),
            OWNER_EMAIL: "owner@example.test",
            ACCESS_TEAM_DOMAIN: "https://unit-test.cloudflareaccess.com",
            ACCESS_AUD: "test-audience",
            ALLOWED_REDIRECT_HOSTS: "claude.ai,claude.com",
            TEST_MIGRATIONS: migrations
          }
        }
      };
    })
  ],
  test: { include: ["test/**/*.test.mjs"], setupFiles: ["./test/setup.mjs"] }
});
