#!/usr/bin/env node
/**
 * Keep-alive ping.
 *
 * Supabase pauses a free-tier project after ~7 days with no activity. This
 * writes one row into the `keep_alive` table so the project never sits idle
 * that long.
 *
 * Talks to Supabase's REST API directly rather than going through the deployed
 * /api/keep-alive route. That keeps Vercel out of the path entirely -- a failed
 * deploy or an outage there can no longer take the keep-alive down with it.
 *
 * Uses only Node built-ins and global fetch, so CI needs no `npm install`.
 *
 * Credentials, in priority order:
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL   - project URL
 *   SUPABASE_SERVICE_ROLE_KEY                  - service_role key (bypasses RLS)
 * Real environment variables always win; .env.local is only a local fallback,
 * so CI behaviour is never affected by a stray file.
 *
 * Exits non-zero on failure so a scheduler shows red, instead of reporting
 * success while the project quietly pauses.
 *
 * Usage:  npm run keep-alive
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RETRIES = 3;
const RETRY_DELAY_MS = 4000;
const TIMEOUT_MS = 20000;

const ok = (...a) => console.log("[keep-alive]", ...a);
const die = (msg) => { console.error("[keep-alive] \u2717", msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal .env parser: KEY=VALUE, optional quotes, # comments, CRLF-safe. */
function loadEnvLocal() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const file = resolve(root, ".env.local");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;   // real env wins
  }
}

/** Cloudflare/Supabase codes that mean the origin itself is unreachable. */
const ORIGIN_DOWN = new Set([503, 521, 522, 523, 524]);

async function insertRow(baseUrl, key) {
  const url = `${baseUrl.replace(/\/+$/, "")}/rest/v1/keep_alive`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Ask for the row back, so a no-op cannot masquerade as success
      Prefer: "return=representation",
    },
    body: JSON.stringify({ pinged_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();

  if (ORIGIN_DOWN.has(res.status)) {
    throw new Error(
      `Supabase origin unreachable (HTTP ${res.status}). If the project is ` +
      `genuinely paused, a ping cannot wake it -- restore it from the Supabase dashboard.`
    );
  }
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try { detail = JSON.parse(text).message || detail; } catch {}
    throw new Error(`Supabase returned ${res.status}: ${detail}`);
  }

  let rows;
  try { rows = JSON.parse(text); } catch {
    throw new Error(`unexpected response body: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows[0].id === undefined) {
    throw new Error(`insert reported success but returned no row: ${text.slice(0, 200)}`);
  }
  return rows[0];
}

async function main() {
  loadEnvLocal();

  const baseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !key) {
    die(
      "missing credentials.\n" +
      "  Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "  Locally these are read from .env.local; in CI set them as repository secrets."
    );
  }

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const row = await insertRow(baseUrl, key);
      ok(`\u2713 keep-alive row #${row.id} written at ${row.pinged_at}`);
      return;
    } catch (err) {
      lastErr = err;
      ok(`attempt ${attempt}/${RETRIES} failed: ${err.message}`);
      if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  die(lastErr.message);
}

main().catch((err) => die(err.stack || err.message));
