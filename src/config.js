// Central config + OpenAI client. Loads keys from the project .env.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR = path.join(ROOT, 'vendor');
// RUNS_DIR points scenes at a mounted disk in deployment; local runs stay in-repo.
export const RUNS = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, 'runs');

// The single self-contained three.js build we inline into every scene.
export const THREE_SRC = fs.readFileSync(path.join(VENDOR, 'three.min.js'), 'utf8');

export const DEV_MODEL = process.env.DEV_MODEL || 'gpt-4o-mini';
export const QUALITY_MODEL = process.env.QUALITY_MODEL || 'gpt-4o';

// MODEL env var lets the caller override per run: MODEL=gpt-4o npm run ...
export const MODEL = process.env.MODEL || DEV_MODEL;

if (!process.env.OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY not set (check img2env/.env)');
  process.exit(1);
}

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...a);
}
