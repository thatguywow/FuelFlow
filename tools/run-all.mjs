#!/usr/bin/env node
/**
 * Runs every browser check in sequence against a dev server on :5173.
 *
 * These are the project's real tests. They drive the actual app in a real
 * browser rather than mocking it, because most of what has gone wrong here was
 * invisible to a unit test: CSS utilities losing to each other, a sheet ending
 * under the system navigation bar, a scoring rule that ranked apple strudel
 * above an apple.
 *
 *   npm run dev          # in one terminal
 *   npm run check        # in another
 *
 * `--only=relevance,portions` runs a subset.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',')
  .filter(Boolean);

// `fileURLToPath` rather than picking apart the URL: this project lives in a
// directory with a space and an ampersand in its name, which a hand-rolled
// conversion leaves percent-encoded.
const here = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(here))
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
  .filter((f) => !only || only.some((name) => f.includes(name)))
  .sort();

// `flow` is the end-to-end pass and reads best first.
files.unshift(...(only ? [] : ['flow.mjs']));

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ file, code, out }));
  });

let failed = 0;
for (const file of files) {
  const result = await run(file);
  const summary = result.out.trim().split('\n').at(-1) ?? '';
  const ok = result.code === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} ${summary}`);
  if (!ok) {
    for (const line of result.out.split('\n').filter((l) => l.startsWith('FAIL'))) console.log(`        ${line}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
