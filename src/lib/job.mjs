import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function assertADrive(targetPath, label = '路径') {
  const resolved = path.resolve(targetPath);
  if (path.parse(resolved).root.toUpperCase() !== 'A:\\') {
    throw new Error(`${label}必须位于 A 盘: ${resolved}`);
  }
  return resolved;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  const resolved = assertADrive(filePath, '输出文件');
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

export async function writeText(filePath, value) {
  const resolved = assertADrive(filePath, '输出文件');
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, resolved);
}

export async function preserveRawFile(sourcePath, destinationPath) {
  const destination = assertADrive(destinationPath, '原始文件副本');
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
}

export function makeRunName(name, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const safeName = String(name || 'target').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${stamp}-${safeName}`;
}
