'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key]);
    return output;
  }
  return value;
}

function stableStringify(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeQuietly(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function makeTempDir(prefix, parentDir = os.tmpdir()) {
  ensureDir(parentDir);
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

function runTool(file, args, options = {}) {
  const result = childProcess.spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function assertToolOk(result, tool, args) {
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${tool} ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`);
  }
  return result;
}

function zipFiles(target, files, cwd) {
  const args = ['-X', '-q', target, ...files];
  return assertToolOk(runTool('/usr/bin/zip', args, { cwd }), 'zip', args);
}

function listZipEntries(packagePath) {
  const args = ['-Z1', packagePath];
  const result = assertToolOk(runTool('/usr/bin/unzip', args), 'unzip', args);
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function listZipEntryDetails(packagePath) {
  const entries = listZipEntries(packagePath);
  const args = ['-Z', '-l', packagePath];
  const result = assertToolOk(runTool('/usr/bin/unzip', args), 'unzip', args);
  const lines = String(result.stdout || '').split(/\r?\n/);

  return entries.map((name) => {
    const line = lines.find((candidate) => candidate.endsWith(` ${name}`));
    const match = line?.match(/^\S+\s+\S+\s+\S+\s+(\d+)\s+[tb]-\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!match || match[3] !== name) throw new Error(`无法读取 ZIP 成员大小：${name}`);
    return { name, uncompressedSize: Number(match[1]), compressedSize: Number(match[2]) };
  });
}

function extractZip(packagePath, destination) {
  ensureDir(destination);
  const args = ['-q', packagePath, '-d', destination];
  return assertToolOk(runTool('/usr/bin/unzip', args), 'unzip', args);
}

function isSafeZipEntry(entry) {
  if (!entry || entry.startsWith('/') || entry.startsWith('\\')) return false;
  if (entry.includes('\0') || entry.includes('\\')) return false;
  const normalized = path.posix.normalize(entry);
  return normalized === entry && normalized !== '.' && !normalized.startsWith('../')
    && !normalized.includes('/../') && !entry.endsWith('/');
}

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label || filePath} 不是合法 JSON：${error.message}`);
  }
}

function jsonText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

module.exports = {
  assertToolOk,
  ensureDir,
  extractZip,
  isSafeZipEntry,
  jsonText,
  listZipEntries,
  listZipEntryDetails,
  makeTempDir,
  parseJsonFile,
  removeQuietly,
  runTool,
  sha256,
  sha256File,
  stableStringify,
  zipFiles,
};
