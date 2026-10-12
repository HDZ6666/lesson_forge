'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function randomBetween(min, max) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonStringify(value, fallback = '{}') {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? fallback : result;
  } catch {
    return fallback;
  }
}

function sqliteValue(value, fallback = null) {
  return value === undefined ? fallback : value;
}

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function normalizeId(value) {
  return String(value ?? '').trim();
}

/**
 * A provider identifier is stable when it is numeric or a short, URL-safe
 * token.  Anything else is reported as missing rather than fabricated.
 */
function isStableExternalId(value) {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text);
}

/**
 * Sanitize a value for use inside a file name.  The question collector keeps
 * up to 160 characters; the metadata and legacy collectors pass 120 to keep
 * their historical raw-page file names unchanged.
 */
function safeFilePart(value, maxLength = 160) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, maxLength);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeFileAtomic(target, content) {
  ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parsePositiveInt(value, optionName, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`${optionName} 必须是${allowZero ? '非负' : '正'}整数。`);
  }
  return number;
}

module.exports = {
  ensureDir,
  isStableExternalId,
  jsonStringify,
  normalizeId,
  normalizeWhitespace,
  nowIso,
  parsePositiveInt,
  quoteIdentifier,
  randomBetween,
  safeFilePart,
  sha256,
  sleep,
  sqliteValue,
  writeFileAtomic,
};
