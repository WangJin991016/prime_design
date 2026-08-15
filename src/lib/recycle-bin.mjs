import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './ispcr.mjs';

function assertADriveDirectory(targetPath) {
  const resolved = path.resolve(targetPath);
  if (path.parse(resolved).root.toUpperCase() !== 'A:\\') {
    throw new Error(`回收站目标必须位于 A 盘：${resolved}`);
  }
  return resolved;
}

export async function moveDirectoryToRecycleBin({
  targetPath,
  appRoot,
  runner = runProcess,
  timeoutMs = 120_000,
}) {
  const target = assertADriveDirectory(targetPath);
  const helper = path.resolve(appRoot, 'scripts', 'Move-ToRecycleBin.ps1');
  await stat(target);
  await access(helper);

  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await runner(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', helper,
    '-LiteralPath', target,
  ], { timeoutMs });

  try {
    await stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { targetPath: target, recycled: true };
    throw error;
  }
  throw new Error('回收站操作返回成功，但批次目录仍然存在。');
}
