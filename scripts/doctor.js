#!/usr/bin/env node
import { doctorHermes, parseCliArgs } from './hermes-install-lib.js';

try {
  const result = doctorHermes(parseCliArgs(process.argv.slice(2)));
  for (const check of result.checks) console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(`[FAIL] ${error?.message || error}`);
  process.exitCode = 1;
}
