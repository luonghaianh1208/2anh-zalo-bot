#!/usr/bin/env node
import { parseCliArgs, uninstallHermes } from './hermes-install-lib.js';

try {
  const result = uninstallHermes(parseCliArgs(process.argv.slice(2)));
  for (const path of result.removed) console.log(`[REMOVED] ${path}`);
  console.log('Đã giữ nguyên .env, phiên Zalo, SQLite và config.yaml.');
} catch (error) {
  console.error(`[FAIL] ${error?.message || error}`);
  process.exitCode = 1;
}
