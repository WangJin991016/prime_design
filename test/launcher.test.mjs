import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('double-click launcher exits CMD and starts the hidden health-checked helper', async () => {
  const command = await readFile(path.join(projectRoot, 'Start-PrimerDesignApp.cmd'), 'utf8');
  const helper = await readFile(path.join(projectRoot, 'scripts', 'Start-PrimerDesignApp.ps1'), 'utf8');
  assert.match(command, /powershell\.exe .* -WindowStyle Hidden/i);
  assert.match(command, /exit \/b 0/i);
  assert.doesNotMatch(command, /node src\\app\.mjs --open/i);
  assert.doesNotMatch(helper, /[^\x00-\x7F]/, 'Windows PowerShell 5.1 must parse the BOM-less launcher as ASCII');
  assert.match(helper, /prime-design-local-v1/);
  assert.match(helper, /\/api\/health/);
  assert.match(helper, /RedirectStandardOutput/);
  assert.match(helper, /RedirectStandardError/);
  assert.match(helper, /Join-Path \$projectRoot 'logs'/);
  assert.match(helper, /SetEnvironmentVariable\('PATH', \$null/);
  assert.match(helper, /Start-Process \$appUrl/);
});
