#!/usr/bin/env node
/**
 * Parses every workflow file so a YAML mistake is caught here rather than by a
 * push that fails with nothing more useful than "this run likely failed because
 * of a workflow file issue".
 *
 * The mistake that prompted this: a multi-line `--notes "..."` string inside a
 * `run: |` block put continuation lines at column zero, which silently ends the
 * block scalar and makes the rest of the file unparseable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const DIR = '.github/workflows';
let failed = 0;

for (const file of readdirSync(DIR)) {
  if (!/\.ya?ml$/.test(file)) continue;
  const full = path.join(DIR, file);
  try {
    const doc = YAML.parse(readFileSync(full, 'utf8'));
    const jobs = Object.keys(doc?.jobs ?? {});
    if (jobs.length === 0) throw new Error('no jobs defined');
    console.log(`  ok    ${file.padEnd(24)} jobs: ${jobs.join(', ')}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${file.padEnd(24)} ${error.message.split('\n')[0]}`);
  }
}

console.log(failed === 0 ? '\nAll workflows parse.' : `\n${failed} workflow(s) failed to parse.`);
process.exit(failed === 0 ? 0 : 1);
