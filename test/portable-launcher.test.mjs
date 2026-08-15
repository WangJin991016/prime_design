import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('portable launcher is a self-contained Windows GUI supervisor with fixed loopback port', async () => {
  const project = await readFile(path.join(root, 'launcher', 'PrimerDesignLauncher', 'PrimerDesignLauncher.csproj'), 'utf8');
  const source = await readFile(path.join(root, 'launcher', 'PrimerDesignLauncher', 'Program.cs'), 'utf8');
  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  assert.match(project, /<SelfContained>true<\/SelfContained>/);
  assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
  assert.match(project, /<IncludeSourceRevisionInInformationalVersion>false<\/IncludeSourceRevisionInInformationalVersion>/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /runtime.*node.*node\.exe/s);
  assert.match(source, /PRIME_DESIGN_DATA_ROOT/);
  assert.match(source, /--no-open/);
  assert.match(source, /private static void Main/);
  assert.match(source, /private static void Run/);
  assert.match(source, /Run\(args\);/);
  assert.match(source, /Environment\.Exit\(0\);/);
  assert.match(source, /child\.WaitForExit\(\)/);
  assert.doesNotMatch(source, /WaitForExitAsync|async Task Main/);
  assert.match(source, /ReadToEndAsync/);
  assert.doesNotMatch(source, /BeginOutputReadLine|OutputDataReceived/);
  assert.doesNotMatch(source, /cmd\.exe|powershell\.exe/i);
});

test('portable build copies only production resources and creates hashes', async () => {
  const source = await readFile(path.join(root, 'scripts', 'Build-PortableApp.ps1'), 'utf8');
  const appSource = await readFile(path.join(root, 'src', 'app.mjs'), 'utf8');
  assert.match(source, /vendor\\node\\node-v24\.18\.0-win-x64\.zip/);
  assert.match(source, /vendor\\dotnet\\sdk-8\.0\.424\\dotnet\.exe/);
  assert.match(source, /DOTNET_CLI_HOME/);
  assert.match(source, /NUGET_PACKAGES/);
  assert.match(source, /runtime\\node\\node\.exe/);
  assert.match(source, /manifest\.json/);
  assert.match(source, /zipPath\.sha256/);
  assert.match(source, /Move-ToRecycleBin\.ps1/);
  assert.match(source, /web-parameters\.mjs/);
  assert.match(source, /config\\default\.example\.json/);
  assert.doesNotMatch(source, /config\\default\.json'\) -Destination/);
  assert.match(appSource, /dataConfigPath/);
  assert.match(appSource, /existsSync\(dataConfigPath\)/);
  assert.doesNotMatch(source, /Copy-Item.*(?:batches|backups|runs|tools)/i);
  assert.doesNotMatch(source, /Copy-Item[^\r\n]*scripts\\server[^\r\n]*-Recurse/i);
});
