#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PROVIDER = 'zujuan';
const DEFAULT_BASE_URL = 'https://zujuan.xkw.com';
const DEFAULT_SEED_URL = 'https://zujuan.xkw.com/czsx/zj261314/o2/';
const ALLOWED_PAGE_HOSTS = new Set(['zujuan.xkw.com']);

const BLOCK_TEXT_MARKERS = [
  '已阻断',
  '阻断页面',
  '安全威胁',
  '访问被阻断',
  '滑动验证',
  '请完成安全验证',
  '访问过于频繁',
  '异常访问',
  '拖动滑块完成拼图',
  '请按住滑块',
  '访问验证',
  '请输入验证码',
  'captcha',
];
const CHAPTER_TEXTBOOKS_PATH = '/zujuan-api/chaptertextbooks';
const SOURCE_CONTENT_SELECTOR = '#chapter_textbook_version, .tk-tree, .tk-quest-item, .quest-content .quesroot';

class StopCrawlError extends Error {
  constructor(message, code = 'blocked') {
    super(message);
    this.name = 'StopCrawlError';
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(target, data) {
  ensureDir(path.dirname(target));
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, target);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

function parsePositiveInt(value, optionName, { allowZero = false } = {}) {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  if (!valid) throw new Error(`${optionName} 必须是${allowZero ? '非负' : '正'}整数。`);
  return parsed;
}

function usage() {
  return `
组卷网版本与教材元数据发现工具

用法：
  cd collector && npm run sync:zujuan:metadata -- --acknowledge-source-policy [选项]

选项：
  --acknowledge-source-policy 确认已核对来源站规则/授权范围（运行必需）
  --seed-url <url>            初中数学题库入口页；默认 ${DEFAULT_SEED_URL}
  --db <path>                 SQLite 路径；默认 data/zujuan.sqlite3
  --data-dir <path>           原始页目录；默认 data/zujuan
  --profile-dir <path>        独立浏览器配置目录；默认 .cache/zujuan-sync-profile
  --headful                   显示 Chrome 窗口（默认无头；冷档案或防护阻断时会自动改有头）
  --timeout <ms>              页面超时；默认 30000
  --delay-min <ms>            每次请求最小间隔；默认 2200
  --delay-max <ms>            每次请求最大间隔；默认 3800
  --no-save-raw               不保存 gzip 原始页面
  --status                    只读取本地 SQLite，不访问网站
  --json-output <path>        将汇总 JSON 写到文件
  --help                      显示帮助

只发现版本和教材，不抓题目，不写 MySQL。版本下的教材列表走站点 chaptertextbooks 接口，不再点击版本条，也不逐本打开教材页。缺少稳定来源 ID 时停止，不伪造 ID。
`;
}

function parseArgs(argv) {
  const cwd = process.cwd();
  const projectRoot = path.resolve(__dirname);
  const options = {
    seedUrl: DEFAULT_SEED_URL,
    baseUrl: DEFAULT_BASE_URL,
    bankPath: 'czsx',
    delayMin: 2200,
    delayMax: 3800,
    timeout: 30000,
    headless: true,
    saveRaw: true,
    dbPath: path.resolve(projectRoot, 'data/zujuan.sqlite3'),
    dataDir: path.resolve(projectRoot, 'data/zujuan'),
    profileDir: path.resolve(projectRoot, '.cache/zujuan-sync-profile'),
    acknowledgeSourcePolicy: false,
    statusOnly: false,
    jsonOutput: null,
    help: false,
  };

  const needValue = (index, name) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`${name} 缺少参数值。`);
    }
    return argv[index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--acknowledge-source-policy':
        options.acknowledgeSourcePolicy = true;
        break;
      case '--seed-url':
        options.seedUrl = needValue(i, arg);
        i += 1;
        break;
      case '--db':
        options.dbPath = path.resolve(cwd, needValue(i, arg));
        i += 1;
        break;
      case '--data-dir':
        options.dataDir = path.resolve(cwd, needValue(i, arg));
        i += 1;
        break;
      case '--profile-dir':
        options.profileDir = path.resolve(cwd, needValue(i, arg));
        i += 1;
        break;
      case '--headful':
        options.headless = false;
        break;
      case '--timeout':
        options.timeout = parsePositiveInt(needValue(i, arg), arg);
        i += 1;
        break;
      case '--delay-min':
        options.delayMin = parsePositiveInt(needValue(i, arg), arg, { allowZero: true });
        i += 1;
        break;
      case '--delay-max':
        options.delayMax = parsePositiveInt(needValue(i, arg), arg, { allowZero: true });
        i += 1;
        break;
      case '--no-save-raw':
        options.saveRaw = false;
        break;
      case '--status':
        options.statusOnly = true;
        break;
      case '--json-output':
        options.jsonOutput = path.resolve(cwd, needValue(i, arg));
        i += 1;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  if (options.delayMax < options.delayMin) throw new Error('--delay-max 不能小于 --delay-min。');
  let parsedSeed;
  try {
    parsedSeed = new URL(options.seedUrl);
  } catch {
    throw new Error('--seed-url 不是合法 URL。');
  }
  if (parsedSeed.protocol !== 'https:' || !ALLOWED_PAGE_HOSTS.has(parsedSeed.hostname)) {
    throw new Error('--seed-url 必须是 https://zujuan.xkw.com 下的地址。');
  }
  options.seedUrl = parsedSeed.href;
  options.baseUrl = parsedSeed.origin;
  const bank = parsedSeed.pathname.match(/^\/([^/]+)\//);
  if (bank) options.bankPath = bank[1];
  return options;
}

function isStableExternalId(value) {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text);
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isInteger(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseGradeVolume(name) {
  const text = normalizeWhitespace(name);
  if (!text) return { grade: null, volume: null };
  const volumeMatch = text.match(/(上册|下册|全一册)$/);
  const volume = volumeMatch ? volumeMatch[1] : null;
  if (!volume) return { grade: null, volume: null };
  const grade = normalizeWhitespace(text.slice(0, -volume.length)) || null;
  return { grade, volume };
}

function normalizeIsNew(input) {
  if (input == null || input === '') return null;
  if (input === 'Y' || input === 'N') return input;
  if (input === true || input === 1 || input === '1' || input === 'true') return 'Y';
  if (input === false || input === 0 || input === '0' || input === 'false') return 'N';
  if (typeof input === 'object') {
    const className = String(input.className || input.class || '');
    const attrs = input.attributes || {};
    if (
      /\bnew-version\b/.test(className)
      || attrs['data-new'] === 'true'
      || attrs['data-is-new'] === 'Y'
      || input.isNew === true
    ) return 'Y';
    if ('className' in input || 'class' in input || input.attributes) return 'N';
    return null;
  }
  const text = String(input);
  if (/\bnew-version\b/.test(text) || text === '新教材') return 'Y';
  return null;
}

function sameValue(left, right) {
  if (left == null && right == null) return true;
  return String(left) === String(right);
}

function parseAttributes(tag) {
  const attrs = {};
  const re = /([:@A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return attrs;
}

function parseAnchors(html) {
  const items = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attributes = parseAttributes(match[1]);
    const text = normalizeWhitespace(decodeHtmlEntities(String(match[2]).replace(/<[^>]+>/g, '')));
    items.push({ attributes, text, className: attributes.class || '' });
  }
  return items;
}

function sliceElementById(html, id) {
  const pattern = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\sid="${id}"[^>]*>`, 'i');
  const match = pattern.exec(html);
  if (!match) return null;
  const tag = match[1];
  const start = match.index + match[0].length;
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 1;
  let index = start;
  while (index < html.length && depth > 0) {
    openRe.lastIndex = index;
    closeRe.lastIndex = index;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      index = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(start, nextClose.index);
      index = nextClose.index + nextClose[0].length;
    }
  }
  return html.slice(start);
}

function textbookRawJson(textbook) {
  return JSON.stringify({
    href: textbook.href,
    sourceUrl: textbook.sourceUrl,
    qbmid: textbook.qbmid,
    ...(textbook.raw && typeof textbook.raw === 'object' ? textbook.raw : {}),
  });
}

function textbookListSignature(items) {
  return (items || [])
    .map((item) => `${item.externalTextbookId || ''}:${item.textbookName || ''}`)
    .join('|');
}

function textbookSourceUrl(item, options = {}) {
  const href = item.href || item.attributes?.href;
  if (href && !String(href).startsWith('javascript:')) {
    try {
      return new URL(href, options.baseUrl || options.seedUrl || DEFAULT_BASE_URL).href;
    } catch {}
  }
  const id = item.externalTextbookId;
  if (isStableExternalId(id)) {
    const bankPath = options.bankPath || 'czsx';
    const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    return new URL(`/${bankPath}/zj${id}/`, baseUrl).href;
  }
  return null;
}

function normalizeVersionRecords(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new StopCrawlError('版本列表为空，可能发生页面契约变化。', 'version_contract');
  }
  return items.map((item, index) => {
    const versionName = normalizeWhitespace(item.versionName || item.text || '');
    if (!versionName) {
      throw new StopCrawlError('版本名称为空，可能发生页面契约变化。', 'version_contract');
    }
    const rawId = item.externalVersionId == null ? '' : String(item.externalVersionId).trim();
    return {
      externalVersionId: rawId || null,
      versionName,
      isNew: normalizeIsNew(item),
      sortOrder: item.sortOrder ?? index,
      sourceUrl: item.sourceUrl || null,
      selected: Boolean(item.selected),
      raw: item,
    };
  });
}

function normalizeTextbookRecords(items, options = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0 && !options.allowEmpty) {
    throw new StopCrawlError('教材列表为空，可能发生页面契约变化。', 'textbook_contract');
  }
  return rows.map((item, index) => {
    const textbookName = normalizeWhitespace(item.textbookName || item.text || '');
    if (!textbookName) {
      throw new StopCrawlError('教材名称为空，可能发生页面契约变化。', 'textbook_contract');
    }
    const rawId = item.externalTextbookId == null ? '' : String(item.externalTextbookId).trim();
    const parsed = parseGradeVolume(textbookName);
    const href = item.href || item.attributes?.href || null;
    return {
      externalTextbookId: rawId || null,
      versionExternalId: options.versionExternalId || item.versionExternalId || null,
      textbookName,
      grade: parsed.grade,
      volume: parsed.volume,
      href,
      sourceUrl: textbookSourceUrl({ ...item, href, externalTextbookId: rawId || null }, options),
      qbmid: item.qbmid || item.attributes?.['data-qbmid'] || null,
      sortOrder: item.sortOrder ?? index,
      bootstrapChapterExternalId: item.bootstrapChapterExternalId || null,
      selected: Boolean(item.selected),
      raw: item,
    };
  });
}

function parseVersionsFromHtml(html, extra = {}) {
  const inner = sliceElementById(html, 'chapter_textbook_version');
  if (inner == null) {
    throw new StopCrawlError('页面缺少版本选择区域 #chapter_textbook_version。', 'version_contract');
  }
  const raw = parseAnchors(inner).map((anchor, index) => ({
    externalVersionId: anchor.attributes.versionid
      || anchor.attributes['data-versionid']
      || anchor.attributes['data-version-id']
      || null,
    versionName: anchor.text,
    className: anchor.className,
    selected: /\bselected\b/.test(anchor.className),
    urlTemplate: anchor.attributes.url || null,
    href: anchor.attributes.href || null,
    qbmid: anchor.attributes['data-qbmid'] || null,
    sortOrder: index,
    sourceUrl: extra.sourceUrl || null,
    attributes: anchor.attributes,
  }));
  return normalizeVersionRecords(raw);
}

function buildChapterTextbooksUrl(version, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const bankPath = options.bankPath || 'czsx';
  const template = version.urlTemplate
    || version.raw?.url
    || version.raw?.attributes?.url
    || version.attributes?.url
    || `/${bankPath}/zj{0}/`;
  const parsed = new URL(CHAPTER_TEXTBOOKS_PATH, baseUrl);
  parsed.searchParams.set('textbookVersionId', String(version.externalVersionId));
  parsed.searchParams.set('url', String(template));
  return parsed.href;
}

function classifyHtmlProtection(html) {
  const text = String(html || '');
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const captcha = /id=["']parm_[01]["']|aliyunCaptcha|滑动验证/i.test(text);
  const hasTextbookMarkup = /id=["']chapter_textbooks["']|chapter-id=|\/zj\d+\//i.test(text);
  return classifyProtectionState({
    title,
    text: `${title} ${stripped}`,
    hasChallengeInputs: captcha,
    hasContent: hasTextbookMarkup && !captcha,
  });
}

function parseTextbooksFromApiHtml(html, options = {}) {
  const text = String(html || '');
  const protection = classifyHtmlProtection(text);
  if (protection.terminalBlock || (protection.transientChallenge && !protection.hasContent)) {
    throw new StopCrawlError(protectionStopMessage(protection), 'challenge');
  }
  const wrapped = sliceElementById(text, 'chapter_textbooks') == null
    ? `<div id="chapter_textbooks">${text}</div>`
    : text;
  return parseTextbooksFromHtml(wrapped, options);
}

function parseTextbooksFromHtml(html, options = {}) {
  const inner = sliceElementById(html, 'chapter_textbooks');
  if (inner == null) {
    throw new StopCrawlError('页面缺少教材选择区域 #chapter_textbooks。', 'textbook_contract');
  }
  const raw = parseAnchors(inner).map((anchor, index) => {
    const href = anchor.attributes.href || '';
    const fromHref = href.match(/\/zj(\d+)\b/);
    return {
      externalTextbookId: anchor.attributes['chapter-id'] || (fromHref ? fromHref[1] : null),
      textbookName: anchor.text,
      href,
      qbmid: anchor.attributes['data-qbmid'] || null,
      selected: /\bselected\b/.test(anchor.className),
      className: anchor.className,
      sortOrder: index,
      attributes: anchor.attributes,
    };
  }).filter((item) => item.textbookName && !item.textbookName.includes('加载中'));
  return normalizeTextbookRecords(raw, options);
}

function parseBootstrapChapterFromHtml(html) {
  const treeOpen = html.match(/<div\b[^>]*\btk-tree\b[^>]*>/i);
  const treeIdFromClassFirst = treeOpen?.[0].match(/\btree-id="([^"]+)"/i)?.[1] || null;
  const level1 = html.match(/<li\b[^>]*\bdata-level="1"[^>]*>/i)
    || html.match(/<li\b[^>]*\btree-id="[^"]+"[^>]*\bdata-level="1"[^>]*>/i);
  const bootstrapFromLevel = level1?.[0].match(/\btree-id="([^"]+)"/i)?.[1]
    || html.match(/<li\b[^>]*\btree-id="([^"]+)"[^>]*\bdata-level="1"/i)?.[1]
    || null;
  const fallbackLevel = html.match(/<li\b[^>]*\bdata-level="1"[^>]*\btree-id="([^"]+)"/i)?.[1] || null;
  return {
    textbookTreeId: treeIdFromClassFirst,
    bootstrapChapterExternalId: bootstrapFromLevel || fallbackLevel || null,
  };
}

function emptyValidation() {
  return { missingIds: [], duplicateIds: [], missingBootstrapChapters: [] };
}

function validateDiscovery(versions, textbooks) {
  const validation = emptyValidation();
  const versionIds = new Map();
  const textbookIds = new Map();
  for (const version of versions || []) {
    if (!isStableExternalId(version.externalVersionId)) {
      validation.missingIds.push({
        type: 'version',
        name: version.versionName,
        value: version.externalVersionId,
      });
    } else if (versionIds.has(version.externalVersionId)) {
      validation.duplicateIds.push({ type: 'version', id: version.externalVersionId });
    } else {
      versionIds.set(version.externalVersionId, version);
    }
  }
  for (const textbook of textbooks || []) {
    if (!isStableExternalId(textbook.externalTextbookId)) {
      validation.missingIds.push({
        type: 'textbook',
        name: textbook.textbookName,
        value: textbook.externalTextbookId,
      });
    } else if (textbookIds.has(textbook.externalTextbookId)) {
      validation.duplicateIds.push({ type: 'textbook', id: textbook.externalTextbookId });
    } else {
      textbookIds.set(textbook.externalTextbookId, textbook);
    }
    if (!isStableExternalId(textbook.bootstrapChapterExternalId)) {
      validation.missingBootstrapChapters.push({
        externalTextbookId: textbook.externalTextbookId,
        textbookName: textbook.textbookName,
      });
    }
  }
  return validation;
}

function assertDiscoveryIds(versions, textbooks) {
  const validation = validateDiscovery(versions, textbooks);
  if (validation.missingIds.length > 0) {
    throw new StopCrawlError(
      `缺少稳定来源 ID，已停止且未伪造 ID：${validation.missingIds
        .map((item) => `${item.type}:${item.name || item.value || '(空)'}`)
        .join('、')}`,
      'missing_external_id',
    );
  }
  if (validation.duplicateIds.length > 0) {
    throw new StopCrawlError(
      `来源 ID 重复：${validation.duplicateIds.map((item) => `${item.type}:${item.id}`).join('、')}`,
      'duplicate_external_id',
    );
  }
  return validation;
}

function classifyChange(existing, next, fields) {
  if (!existing) return 'inserted';
  const changed = fields.some((field) => !sameValue(existing[field], next[field]));
  return changed ? 'updated' : 'unchanged';
}

class PoliteGate {
  constructor(minDelay, maxDelay) {
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.nextAt = 0;
  }

  async wait(label) {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    if (waitMs > 0) {
      console.log(`[限速] ${label}，等待 ${(waitMs / 1000).toFixed(1)} 秒`);
      await sleep(waitMs);
    }
    this.nextAt = Date.now() + randomBetween(this.minDelay, this.maxDelay);
  }
}

const METADATA_TERMINAL_STATUSES = Object.freeze([
  'success',
  'completed',
  'failed',
  'blocked',
  'cancelled',
]);
const METADATA_TERMINAL_STATUS_SQL = METADATA_TERMINAL_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');
const METADATA_RUN_COLUMN_MIGRATIONS = Object.freeze({
  provider: "TEXT NOT NULL DEFAULT 'zujuan'",
  started_at: "TEXT NOT NULL DEFAULT ''",
  finished_at: 'TEXT',
  status: "TEXT NOT NULL DEFAULT 'unknown'",
  seed_url: 'TEXT',
  version_count: 'INTEGER NOT NULL DEFAULT 0',
  textbook_count: 'INTEGER NOT NULL DEFAULT 0',
  inserted_count: 'INTEGER NOT NULL DEFAULT 0',
  updated_count: 'INTEGER NOT NULL DEFAULT 0',
  unchanged_count: 'INTEGER NOT NULL DEFAULT 0',
  error_count: 'INTEGER NOT NULL DEFAULT 0',
  message: 'TEXT',
  report_json: 'TEXT',
  snapshot_locked_at: 'TEXT',
});

function metadataQuoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function metadataTableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
  );
}

function metadataTableColumns(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${metadataQuoteIdentifier(table)})`).all().map((row) => String(row.name)),
  );
}

function metadataColumn(columns, name, fallbackSql) {
  return columns.has(name) ? metadataQuoteIdentifier(name) : fallbackSql;
}

function backfillMetadataRunSnapshots(db) {
  const tables = metadataTableNames(db);
  if (!tables.has('source_metadata_runs')) return;
  if (tables.has('source_textbook_versions')) {
    const columns = metadataTableColumns(db, 'source_textbook_versions');
    if (columns.has('provider') && columns.has('external_version_id') && columns.has('version_name')) {
      db.exec(`
        INSERT OR IGNORE INTO source_metadata_run_versions (
          run_id, provider, external_version_id, version_name, source_url,
          is_new, sort_order, status, raw_json, captured_at
        )
        SELECT run.id, version.provider, version.external_version_id, version.version_name,
               ${metadataColumn(columns, 'source_url', 'NULL')},
               ${metadataColumn(columns, 'is_new', 'NULL')},
               ${metadataColumn(columns, 'sort_order', '0')},
               ${columns.has('status') ? 'version."status"' : "'0'"},
               ${metadataColumn(columns, 'raw_json', "'{}'")},
               ${metadataColumn(columns, 'last_seen_at', 'run.finished_at')}
        FROM source_metadata_runs AS run
        JOIN source_textbook_versions AS version
          ON version.provider = run.provider
        WHERE run.status IN ('success', 'completed')
          AND run.finished_at IS NOT NULL
          ${columns.has('last_seen_at')
    ? 'AND version.last_seen_at >= run.started_at AND version.last_seen_at <= run.finished_at'
    : ''}
      `);
    }
  }
  if (tables.has('source_textbooks')) {
    const columns = metadataTableColumns(db, 'source_textbooks');
    if (
      columns.has('provider')
      && columns.has('external_textbook_id')
      && columns.has('version_external_id')
      && columns.has('textbook_name')
    ) {
      db.exec(`
        INSERT OR IGNORE INTO source_metadata_run_textbooks (
          run_id, provider, external_textbook_id, version_external_id,
          textbook_name, grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, raw_json, captured_at
        )
        SELECT run.id, textbook.provider, textbook.external_textbook_id,
               textbook.version_external_id, textbook.textbook_name,
               ${metadataColumn(columns, 'grade', 'NULL')},
               ${metadataColumn(columns, 'volume', 'NULL')},
               ${metadataColumn(columns, 'source_url', 'NULL')},
               ${metadataColumn(columns, 'sort_order', '0')},
               ${columns.has('status') ? 'textbook."status"' : "'0'"},
               ${metadataColumn(columns, 'bootstrap_chapter_external_id', 'NULL')},
               ${metadataColumn(columns, 'raw_json', "'{}'")},
               ${metadataColumn(columns, 'last_seen_at', 'run.finished_at')}
        FROM source_metadata_runs AS run
        JOIN source_textbooks AS textbook
          ON textbook.provider = run.provider
        WHERE run.status IN ('success', 'completed')
          AND run.finished_at IS NOT NULL
          ${columns.has('last_seen_at')
    ? 'AND textbook.last_seen_at >= run.started_at AND textbook.last_seen_at <= run.finished_at'
    : ''}
      `);
    }
  }
}

function migrateMetadataSnapshotSchema(db) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_metadata_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        seed_url TEXT,
        version_count INTEGER NOT NULL DEFAULT 0,
        textbook_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        report_json TEXT,
        snapshot_locked_at TEXT
      );
    `);
    const runColumns = metadataTableColumns(db, 'source_metadata_runs');
    for (const [name, definition] of Object.entries(METADATA_RUN_COLUMN_MIGRATIONS)) {
      if (runColumns.has(name)) continue;
      db.exec(
        `ALTER TABLE source_metadata_runs ADD COLUMN ${metadataQuoteIdentifier(name)} ${definition}`,
      );
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_metadata_run_versions (
        run_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        external_version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        source_url TEXT,
        is_new TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        raw_json TEXT NOT NULL DEFAULT '{}',
        captured_at TEXT NOT NULL,
        PRIMARY KEY (run_id, provider, external_version_id),
        FOREIGN KEY (run_id) REFERENCES source_metadata_runs(id)
      );

      CREATE TABLE IF NOT EXISTS source_metadata_run_textbooks (
        run_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        external_textbook_id TEXT NOT NULL,
        version_external_id TEXT NOT NULL,
        textbook_name TEXT NOT NULL,
        grade TEXT,
        volume TEXT,
        source_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        bootstrap_chapter_external_id TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}',
        captured_at TEXT NOT NULL,
        PRIMARY KEY (run_id, provider, external_textbook_id),
        FOREIGN KEY (run_id) REFERENCES source_metadata_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_metadata_run_versions_order
        ON source_metadata_run_versions (run_id, provider, sort_order, external_version_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_run_textbooks_version
        ON source_metadata_run_textbooks (
          run_id, provider, version_external_id, sort_order, external_textbook_id
        );

      DROP TRIGGER IF EXISTS trg_source_metadata_runs_no_reopen;
      DROP TRIGGER IF EXISTS trg_metadata_run_versions_no_insert;
      DROP TRIGGER IF EXISTS trg_metadata_run_versions_no_update;
      DROP TRIGGER IF EXISTS trg_metadata_run_versions_no_delete;
      DROP TRIGGER IF EXISTS trg_metadata_run_textbooks_no_insert;
      DROP TRIGGER IF EXISTS trg_metadata_run_textbooks_no_update;
      DROP TRIGGER IF EXISTS trg_metadata_run_textbooks_no_delete;
    `);
    backfillMetadataRunSnapshots(db);
    db.exec(`
      UPDATE source_metadata_runs
      SET snapshot_locked_at = COALESCE(
        snapshot_locked_at,
        NULLIF(finished_at, ''),
        NULLIF(started_at, ''),
        datetime('now')
      )
      WHERE snapshot_locked_at IS NULL
        AND COALESCE(status, '') IN (${METADATA_TERMINAL_STATUS_SQL});

      CREATE TRIGGER trg_source_metadata_runs_no_reopen
      BEFORE UPDATE ON source_metadata_runs
      WHEN OLD.snapshot_locked_at IS NOT NULL
        OR COALESCE(OLD.status, '') IN (${METADATA_TERMINAL_STATUS_SQL})
      BEGIN
        SELECT RAISE(ABORT, 'terminal metadata runs are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_versions_no_insert
      BEFORE INSERT ON source_metadata_run_versions
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata version snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_versions_no_update
      BEFORE UPDATE ON source_metadata_run_versions
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata version snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_versions_no_delete
      BEFORE DELETE ON source_metadata_run_versions
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata version snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_textbooks_no_insert
      BEFORE INSERT ON source_metadata_run_textbooks
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata textbook snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_textbooks_no_update
      BEFORE UPDATE ON source_metadata_run_textbooks
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata textbook snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_textbooks_no_delete
      BEFORE DELETE ON source_metadata_run_textbooks
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata textbook snapshots are immutable');
      END;
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function ensureMetadataSnapshotSchema(dbPath) {
  const resolved = path.resolve(dbPath);
  ensureDir(path.dirname(resolved));
  const db = new DatabaseSync(resolved);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    migrateMetadataSnapshotSchema(db);
  } finally {
    db.close();
  }
}

class MetadataStore {
  constructor(dbPath) {
    ensureDir(path.dirname(dbPath));
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_textbook_versions (
        provider TEXT NOT NULL,
        external_version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        source_url TEXT,
        is_new TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (provider, external_version_id)
      );

      CREATE TABLE IF NOT EXISTS source_textbooks (
        provider TEXT NOT NULL,
        external_textbook_id TEXT NOT NULL,
        version_external_id TEXT NOT NULL,
        textbook_name TEXT NOT NULL,
        grade TEXT,
        volume TEXT,
        source_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        bootstrap_chapter_external_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (provider, external_textbook_id),
        FOREIGN KEY (provider, version_external_id)
          REFERENCES source_textbook_versions (provider, external_version_id)
      );

      CREATE TABLE IF NOT EXISTS source_metadata_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        seed_url TEXT,
        version_count INTEGER NOT NULL DEFAULT 0,
        textbook_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        report_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_source_textbooks_version
        ON source_textbooks (provider, version_external_id);
    `);
    migrateMetadataSnapshotSchema(this.db);
  }

  prepare() {
    this.stmt = {
      insertRun: this.db.prepare(`
        INSERT INTO source_metadata_runs (provider, started_at, status, seed_url)
        VALUES (?, ?, 'running', ?)
      `),
      finishRun: this.db.prepare(`
        UPDATE source_metadata_runs
        SET finished_at = ?, status = ?, version_count = ?, textbook_count = ?,
            inserted_count = ?, updated_count = ?, unchanged_count = ?,
            error_count = ?, message = ?, report_json = ?, snapshot_locked_at = ?
        WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
      `),
      getVersion: this.db.prepare(`
        SELECT * FROM source_textbook_versions
        WHERE provider = ? AND external_version_id = ?
      `),
      getTextbook: this.db.prepare(`
        SELECT * FROM source_textbooks
        WHERE provider = ? AND external_textbook_id = ?
      `),
      upsertVersion: this.db.prepare(`
        INSERT INTO source_textbook_versions (
          provider, external_version_id, version_name, source_url, is_new,
          sort_order, status, first_seen_at, last_seen_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, '0', ?, ?, ?)
        ON CONFLICT (provider, external_version_id) DO UPDATE SET
          version_name = excluded.version_name,
          source_url = excluded.source_url,
          is_new = excluded.is_new,
          sort_order = excluded.sort_order,
          last_seen_at = excluded.last_seen_at,
          raw_json = excluded.raw_json
      `),
      upsertTextbook: this.db.prepare(`
        INSERT INTO source_textbooks (
          provider, external_textbook_id, version_external_id, textbook_name,
          grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, first_seen_at, last_seen_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?)
        ON CONFLICT (provider, external_textbook_id) DO UPDATE SET
          version_external_id = excluded.version_external_id,
          textbook_name = excluded.textbook_name,
          grade = excluded.grade,
          volume = excluded.volume,
          source_url = excluded.source_url,
          sort_order = excluded.sort_order,
          bootstrap_chapter_external_id = COALESCE(
            excluded.bootstrap_chapter_external_id,
            source_textbooks.bootstrap_chapter_external_id
          ),
          last_seen_at = excluded.last_seen_at,
          raw_json = excluded.raw_json
      `),
      insertRunVersion: this.db.prepare(`
        INSERT INTO source_metadata_run_versions (
          run_id, provider, external_version_id, version_name, source_url,
          is_new, sort_order, status, raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?)
      `),
      insertRunTextbook: this.db.prepare(`
        INSERT INTO source_metadata_run_textbooks (
          run_id, provider, external_textbook_id, version_external_id,
          textbook_name, grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?)
      `),
      listVersions: this.db.prepare(`
        SELECT * FROM source_textbook_versions
        WHERE provider = ?
        ORDER BY sort_order ASC, external_version_id ASC
      `),
      listTextbooks: this.db.prepare(`
        SELECT * FROM source_textbooks
        WHERE provider = ?
        ORDER BY version_external_id ASC, sort_order ASC, external_textbook_id ASC
      `),
      recentRuns: this.db.prepare(`
        SELECT id, started_at, finished_at, status, seed_url, version_count,
               textbook_count, inserted_count, updated_count, unchanged_count,
               error_count, message
        FROM source_metadata_runs
        ORDER BY id DESC
        LIMIT 20
      `),
    };
  }

  beginRun(seedUrl) {
    const result = this.stmt.insertRun.run(PROVIDER, nowIso(), seedUrl || null);
    return Number(result.lastInsertRowid);
  }

  finishRun(runId, status, counters, message, report) {
    const finishedAt = nowIso();
    const result = this.stmt.finishRun.run(
      finishedAt,
      status,
      counters.versionsSeen || 0,
      counters.textbooksSeen || 0,
      counters.inserted || 0,
      counters.updated || 0,
      counters.unchanged || 0,
      counters.errors || 0,
      message || null,
      report ? JSON.stringify(report) : null,
      finishedAt,
      runId,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error(`metadata run ${runId} 已终止或不存在，不能重新写入终态。`);
    }
  }

  getVersion(externalVersionId) {
    return this.stmt.getVersion.get(PROVIDER, String(externalVersionId)) || null;
  }

  getTextbook(externalTextbookId) {
    return this.stmt.getTextbook.get(PROVIDER, String(externalTextbookId)) || null;
  }

  listVersions() {
    return this.stmt.listVersions.all(PROVIDER);
  }

  listTextbooks() {
    return this.stmt.listTextbooks.all(PROVIDER);
  }

  saveVersionGroup(version, textbooks, observedAt, runId = null) {
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existingVersion = this.getVersion(version.externalVersionId);
      const versionKind = classifyChange(existingVersion, {
        version_name: version.versionName,
        source_url: version.sourceUrl,
        is_new: version.isNew,
        sort_order: version.sortOrder,
      }, ['version_name', 'source_url', 'is_new', 'sort_order']);
      this.stmt.upsertVersion.run(
        PROVIDER,
        String(version.externalVersionId),
        version.versionName,
        version.sourceUrl || null,
        version.isNew,
        version.sortOrder,
        observedAt,
        observedAt,
        JSON.stringify(version.raw || version),
      );
      if (runId != null) {
        this.stmt.insertRunVersion.run(
          Number(runId),
          PROVIDER,
          String(version.externalVersionId),
          version.versionName,
          version.sourceUrl || null,
          version.isNew,
          version.sortOrder,
          JSON.stringify(version.raw || version),
          observedAt,
        );
      }
      counts[versionKind] += 1;

      for (const textbook of textbooks) {
        const existingTextbook = this.getTextbook(textbook.externalTextbookId);
        if (!isStableExternalId(textbook.bootstrapChapterExternalId) && existingTextbook) {
          textbook.bootstrapChapterExternalId = existingTextbook.bootstrap_chapter_external_id || null;
        }
        const textbookKind = classifyChange(existingTextbook, {
          version_external_id: textbook.versionExternalId,
          textbook_name: textbook.textbookName,
          grade: textbook.grade,
          volume: textbook.volume,
          source_url: textbook.sourceUrl,
          sort_order: textbook.sortOrder,
          bootstrap_chapter_external_id: textbook.bootstrapChapterExternalId,
        }, [
          'version_external_id',
          'textbook_name',
          'grade',
          'volume',
          'source_url',
          'sort_order',
          'bootstrap_chapter_external_id',
        ]);
        this.stmt.upsertTextbook.run(
          PROVIDER,
          String(textbook.externalTextbookId),
          String(textbook.versionExternalId),
          textbook.textbookName,
          textbook.grade,
          textbook.volume,
          textbook.sourceUrl || null,
          textbook.sortOrder,
          textbook.bootstrapChapterExternalId || null,
          observedAt,
          observedAt,
          textbookRawJson(textbook),
        );
        if (runId != null) {
          this.stmt.insertRunTextbook.run(
            Number(runId),
            PROVIDER,
            String(textbook.externalTextbookId),
            String(textbook.versionExternalId),
            textbook.textbookName,
            textbook.grade,
            textbook.volume,
            textbook.sourceUrl || null,
            textbook.sortOrder,
            textbook.bootstrapChapterExternalId || null,
            textbookRawJson(textbook),
            observedAt,
          );
        }
        counts[textbookKind] += 1;
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
    return counts;
  }

  unseenCandidates(seenVersionIds, seenTextbookIds) {
    const versions = this.listVersions()
      .filter((row) => !seenVersionIds.has(String(row.external_version_id)))
      .map((row) => ({
        externalVersionId: row.external_version_id,
        versionName: row.version_name,
      }));
    const textbooks = this.listTextbooks()
      .filter((row) => !seenTextbookIds.has(String(row.external_textbook_id)))
      .map((row) => ({
        externalTextbookId: row.external_textbook_id,
        textbookName: row.textbook_name,
        versionExternalId: row.version_external_id,
      }));
    return { versions, textbooks };
  }

  status() {
    return {
      versions: this.listVersions(),
      textbooks: this.listTextbooks(),
      recentRuns: this.stmt.recentRuns.all(),
    };
  }

  close() {
    this.db.close();
  }
}

function pickExactByName(items, name, { nameKey, label }) {
  const wanted = normalizeWhitespace(name);
  const matched = (items || []).filter((item) => normalizeWhitespace(item[nameKey] || '') === wanted);
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) {
    throw new Error(`${label}「${wanted}」匹配到 ${matched.length} 条，拒绝合并。`);
  }
  const available = [...new Set((items || []).map((item) => item[nameKey]).filter(Boolean))];
  throw new Error(`未找到${label}「${wanted}」。当前可见：${available.join('、') || '（空）'}`);
}

function lookupTextbookByNames(dbPath, versionName, textbookName, { provider = PROVIDER } = {}) {
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const table = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_textbooks'`,
    ).get();
    if (!table) return null;
    const row = db.prepare(`
      SELECT t.external_textbook_id, t.textbook_name, t.bootstrap_chapter_external_id, t.source_url,
             v.external_version_id, v.version_name
      FROM source_textbooks t
      JOIN source_textbook_versions v
        ON v.provider = t.provider AND v.external_version_id = t.version_external_id
      WHERE t.provider = ? AND v.version_name = ? AND t.textbook_name = ?
    `).get(provider, normalizeWhitespace(versionName), normalizeWhitespace(textbookName));
    if (!row) return null;
    const bootstrap = row.bootstrap_chapter_external_id == null
      ? ''
      : String(row.bootstrap_chapter_external_id).trim();
    if (!isStableExternalId(bootstrap) || !isStableExternalId(row.external_textbook_id)) return null;
    return {
      externalTextbookId: String(row.external_textbook_id),
      textbookName: row.textbook_name,
      bootstrapChapterExternalId: bootstrap,
      sourceUrl: row.source_url,
      externalVersionId: String(row.external_version_id),
      versionName: row.version_name,
    };
  } finally {
    db.close();
  }
}

function lookupBootstrapChapter(dbPath, textbookId, { provider = PROVIDER, allowMissing = false } = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`采集库不存在：${dbPath}。请先运行 npm run sync:zujuan:metadata`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_textbooks'`,
    ).get();
    if (!table) {
      if (allowMissing) return null;
      throw new Error('采集库缺少 source_textbooks 表。请先运行 npm run sync:zujuan:metadata');
    }
    const row = db.prepare(
      `SELECT textbook_name, bootstrap_chapter_external_id
       FROM source_textbooks
       WHERE provider = ? AND external_textbook_id = ?`,
    ).get(provider, String(textbookId));
    if (!row) {
      if (allowMissing) return null;
      throw new Error(`采集库中没有教材 ${textbookId} 的元数据。请先运行 npm run sync:zujuan:metadata`);
    }
    const bootstrap = row.bootstrap_chapter_external_id == null
      ? ''
      : String(row.bootstrap_chapter_external_id).trim();
    if (!isStableExternalId(bootstrap)) {
      if (allowMissing) return null;
      throw new Error(
        `教材 ${textbookId}（${row.textbook_name || '未命名'}）缺少可用的入口章节 ID，无法构造同步入口。`,
      );
    }
    return String(bootstrap);
  } finally {
    db.close();
  }
}

function buildReport(store, extras = {}) {
  const versions = store.listVersions();
  const textbooks = store.listTextbooks();
  const countByVersion = new Map();
  for (const textbook of textbooks) {
    const key = String(textbook.version_external_id);
    countByVersion.set(key, (countByVersion.get(key) || 0) + 1);
  }
  return {
    provider: PROVIDER,
    versionCount: versions.length,
    textbookCount: textbooks.length,
    versions: versions.map((version) => ({
      externalVersionId: version.external_version_id,
      versionName: version.version_name,
      isNew: version.is_new,
      textbookCount: countByVersion.get(String(version.external_version_id)) || 0,
    })),
    validation: extras.validation || emptyValidation(),
    counts: extras.counts || null,
    unseen: extras.unseen || null,
  };
}

function formatReport(report) {
  const lines = [
    `版本总数：${report.versionCount}`,
    `教材总数：${report.textbookCount}`,
    '按版本：',
  ];
  if (report.versions.length === 0) {
    lines.push('  （无）');
  } else {
    for (const version of report.versions) {
      lines.push(
        `  ${version.versionName} (${version.externalVersionId})  is_new=${version.isNew ?? 'NULL'}  教材数=${version.textbookCount}`,
      );
    }
  }
  const validation = report.validation || emptyValidation();
  lines.push('校验：');
  lines.push(`  缺失来源 ID：${validation.missingIds.length}`);
  lines.push(`  重复来源 ID：${validation.duplicateIds.length}`);
  lines.push(`  缺少入口章节 ID 的教材：${validation.missingBootstrapChapters.length}`);
  if (report.counts) {
    lines.push(
      `本次：新增 ${report.counts.inserted} / 更新 ${report.counts.updated} / 未变化 ${report.counts.unchanged}`,
    );
  }
  if (report.unseen) {
    lines.push(
      `本次未发现候选：版本 ${report.unseen.versions.length}，教材 ${report.unseen.textbooks.length}`,
    );
  }
  return lines.join('\n');
}

function writeJsonOutput(filePath, report) {
  if (!filePath) return;
  writeFileAtomic(filePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[输出] JSON 已写入 ${filePath}`);
}

function acquireLock(lockPath) {
  ensureDir(path.dirname(lockPath));
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: nowIso() }));
  } catch (error) {
    if (error.code === 'EEXIST') {
      let stale = false;
      try {
        const state = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const pid = Number(state.pid);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (processError) {
            stale = processError.code === 'ESRCH';
          }
        }
      } catch {}
      if (stale) {
        fs.unlinkSync(lockPath);
        return acquireLock(lockPath);
      }
      throw new Error(`已有同步任务持有锁：${lockPath}。`);
    }
    throw error;
  }
  return () => {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  };
}

function assertAllowedUrl(rawUrl, allowedHosts) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    throw new StopCrawlError(`拒绝访问未授权域名：${parsed.href}`, 'host_not_allowed');
  }
  return parsed.href;
}

function profileLooksWarm(profileDir) {
  const root = String(profileDir || '').trim();
  if (!root) return false;
  const candidates = [
    path.join(root, 'Default', 'Network', 'Cookies'),
    path.join(root, 'Default', 'Cookies'),
  ];
  return candidates.some((item) => {
    try {
      return fs.existsSync(item) && fs.statSync(item).size > 0;
    } catch {
      return false;
    }
  });
}

function chooseInitialHeadless(options = {}) {
  if (options.headless === false) return false;
  if (!profileLooksWarm(options.profileDir)) return false;
  return true;
}

function applyInitialChromeMode(options) {
  const requestedHeadless = options.headless !== false;
  options.headless = chooseInitialHeadless(options);
  if (requestedHeadless && options.headless === false) {
    console.log('[环境] 采集档案是冷会话，直接使用有头 Chrome');
  }
  return options;
}

function describeChromeMode(options) {
  return `Chrome ${options.headless ? '无头' : '有头'}，档案${profileLooksWarm(options.profileDir) ? '已有会话' : '冷会话'}`;
}

function canFallbackToHeaded(options, error) {
  if (!options || options.headless !== true) return false;
  return Boolean(error) && error.name === 'StopCrawlError' && error.code === 'challenge';
}

function collectorPageIsOpen(page) {
  if (!page) return false;
  try {
    return typeof page.isClosed !== 'function' || !page.isClosed();
  } catch {
    return false;
  }
}

function collectorPageIsBlank(page) {
  if (!collectorPageIsOpen(page)) return false;
  try {
    const url = String(page.url() || '').trim();
    return url === '' || url === 'about:blank' || url === 'chrome://newtab/';
  } catch {
    return false;
  }
}

async function minimizeCollectorWindow(context, page = null) {
  let target = collectorPageIsOpen(page)
    ? page
    : context.pages().find(collectorPageIsOpen);
  let created = false;
  let session;
  try {
    if (!target) {
      target = await context.newPage();
      created = true;
    }
    session = await context.newCDPSession(target);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await session.send('Browser.getWindowBounds', { windowId });
      if (state?.bounds?.windowState === 'minimized') return true;
      if (attempt < 2) await sleep(100);
    }
    return false;
  } catch {
    // Headless, no window, or this Chrome build rejects window-state changes.
    return false;
  } finally {
    if (session && typeof session.detach === 'function') {
      await session.detach().catch(() => {});
    }
    if (created && collectorPageIsOpen(target)) {
      await target.close().catch(() => {});
    }
  }
}

async function minimizeCollectorWindowWithLog(context, options, page = null) {
  if (options?.headless !== false) return true;
  const minimized = await minimizeCollectorWindow(context, page);
  if (minimized) {
    console.log('[环境] Chrome 已最小化，避免挡住当前工作');
  } else {
    console.warn('[环境] Chrome 自动最小化未生效，采集仍会继续');
  }
  return minimized;
}

function markProfileCleanExit(profileDir) {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, `${JSON.stringify(prefs)}\n`);
  } catch {
    // A unreadable profile must not block a new crawl.
  }
}

async function dismissStaleCollectorTabs(context) {
  const pages = context.pages().filter(collectorPageIsOpen);
  if (pages.length <= 1) return pages[0] || null;
  const keep = pages.find(collectorPageIsBlank) || pages[0];
  for (const page of pages) {
    if (page !== keep) await page.close().catch(() => {});
  }
  return keep;
}

async function prepareCollectorPage(context) {
  const pages = context.pages().filter(collectorPageIsOpen);
  const page = pages.find(collectorPageIsBlank) || pages[0];
  if (page) return page;
  return context.newPage();
}

async function newCollectorPage(context, options) {
  const page = await context.newPage();
  await minimizeCollectorWindowWithLog(context, options, page);
  return page;
}

function createCollectorPageFactory(context, options) {
  let firstPageAvailable = true;
  return async () => {
    if (firstPageAvailable) {
      firstPageAvailable = false;
      const page = await prepareCollectorPage(context);
      await minimizeCollectorWindowWithLog(context, options, page);
      return page;
    }
    return newCollectorPage(context, options);
  };
}

async function launchCollectorContext(playwright, options) {
  markProfileCleanExit(options.profileDir);
  const launchOptions = {
    channel: 'chrome',
    headless: options.headless,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (!options.headless) {
    launchOptions.args = [
      '--start-minimized',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
    ];
  }
  const context = await playwright.chromium.launchPersistentContext(options.profileDir, launchOptions);
  context.setDefaultTimeout(options.timeout);
  context.setDefaultNavigationTimeout(options.timeout);
  await dismissStaleCollectorTabs(context);
  const page = await prepareCollectorPage(context);
  if (!options.headless) {
    await minimizeCollectorWindowWithLog(context, options, page);
  }
  return context;
}

async function closeCollectorContext(context) {
  if (!context) return;
  try { await context.close(); } catch {}
}

function classifyProtectionState(state = {}) {
  const title = String(state.title || '');
  const text = String(state.text || '');
  const combined = `${title} ${text}`;
  const lowered = combined.toLowerCase();
  const marker = BLOCK_TEXT_MARKERS.find((item) => lowered.includes(item.toLowerCase())) || null;
  const hasContent = Boolean(state.hasContent);
  const hasChallengeInputs = Boolean(state.hasChallengeInputs);
  return {
    title,
    hasContent,
    hasChallengeInputs,
    marker,
    terminalBlock: Boolean(marker) && !hasContent,
    transientChallenge: hasChallengeInputs && !hasContent && !marker,
  };
}

async function readProtectionSnapshot(page, contentSelector = SOURCE_CONTENT_SELECTOR) {
  return page.evaluate((selector) => {
    const text = document.body?.innerText || '';
    return {
      title: document.title || '',
      text,
      url: location.href,
      hasChallengeInputs: Boolean(document.querySelector('#parm_0, #parm_1')),
      hasContent: Boolean(document.querySelector(selector)),
    };
  }, contentSelector);
}

function protectionStopMessage(state) {
  const marker = state.marker ? ` 标记：${state.marker}` : '';
  const title = state.title ? ` 标题：${state.title}` : '';
  return `站点返回验证/防护页面，任务已熔断。${marker}${title}`.trim();
}

async function settleSourcePage(page, options, extras = {}) {
  const contentSelector = extras.contentSelector || SOURCE_CONTENT_SELECTOR;
  const label = extras.label || '来源页';
  const deadline = Date.now() + (options.timeout || 30000);
  let sawChallenge = false;
  let lastState = classifyProtectionState({});
  while (Date.now() < deadline) {
    try {
      lastState = classifyProtectionState(await readProtectionSnapshot(page, contentSelector));
    } catch (error) {
      if (String(error.message || '').includes('Execution context was destroyed')) {
        await sleep(200);
        continue;
      }
      throw error;
    }
    if (lastState.hasContent) return lastState;
    if (lastState.terminalBlock) {
      throw new StopCrawlError(protectionStopMessage(lastState), 'challenge');
    }
    if (lastState.transientChallenge && !sawChallenge) {
      sawChallenge = true;
      console.warn(`[防护] ${label} 遇到挑战页，等待跳转`);
    }
    await sleep(200);
  }
  if (lastState.terminalBlock || lastState.transientChallenge || lastState.hasChallengeInputs) {
    throw new StopCrawlError(protectionStopMessage(lastState), 'challenge');
  }
  throw new StopCrawlError(
    `${label} 未出现来源内容（${lastState.title || '无标题'}），可能仍在防护页。`,
    'challenge',
  );
}

async function detectBlockedPage(page) {
  const state = classifyProtectionState(await readProtectionSnapshot(page));
  if (state.terminalBlock || (state.hasChallengeInputs && !state.hasContent)) {
    throw new StopCrawlError(protectionStopMessage(state), 'challenge');
  }
  return state;
}

function retryAfterMs(response) {
  if (!response) return null;
  const header = response.headers()['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function safeGoto(page, url, gate, options, label) {
  const target = assertAllowedUrl(url, ALLOWED_PAGE_HOSTS);
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await gate.wait(label);
    try {
      const response = await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout,
      });
      const status = response?.status() || 0;
      if ([401, 403].includes(status)) {
        throw new StopCrawlError(`HTTP ${status}，任务已熔断。`, `http_${status}`);
      }
      if (retryableStatuses.has(status)) {
        const retryMs = retryAfterMs(response) ?? 1000 * (2 ** attempt) + randomBetween(0, 1000);
        if (attempt === 3) throw new StopCrawlError(`HTTP ${status}，重试耗尽。`, `http_${status}`);
        console.warn(`[重试] ${label} 返回 HTTP ${status}，等待 ${(retryMs / 1000).toFixed(1)} 秒`);
        await sleep(retryMs);
        continue;
      }
      if (status >= 400) throw new Error(`${label} 返回 HTTP ${status}`);
      await page.waitForLoadState('domcontentloaded', { timeout: options.timeout });
      await settleSourcePage(page, options, { label });
      return response;
    } catch (error) {
      if (error instanceof StopCrawlError) throw error;
      lastError = error;
      if (attempt === 3) break;
      const backoff = 1000 * (2 ** attempt) + randomBetween(0, 1000);
      console.warn(`[重试] ${label} 失败：${error.message}；等待 ${(backoff / 1000).toFixed(1)} 秒`);
      await sleep(backoff);
    }
  }
  throw lastError || new Error(`${label} 失败。`);
}

async function inspectRobots(context, options) {
  const url = new URL('/robots.txt', options.baseUrl).href;
  try {
    const response = await context.request.get(url, {
      timeout: Math.min(options.timeout, 10000),
      failOnStatusCode: false,
    });
    if ([401, 403].includes(response.status())) {
      return { status: 'unavailable', reason: `HTTP ${response.status()}` };
    }
    const text = await response.text();
    if (!/^\s*user-agent\s*:/im.test(text)) {
      return { status: 'unknown', reason: '返回内容不是可解析的 robots.txt（可能是 JS 防护页）' };
    }
    const disallows = [];
    let applies = false;
    for (const line of text.split(/\r?\n/)) {
      const cleaned = line.replace(/#.*/, '').trim();
      if (!cleaned) continue;
      const [key, ...rest] = cleaned.split(':');
      const value = rest.join(':').trim();
      if (key.toLowerCase() === 'user-agent') applies = value === '*';
      if (applies && key.toLowerCase() === 'disallow' && value) disallows.push(value);
    }
    const targetPath = `/${options.bankPath}/`;
    const blocked = disallows.some((rule) => rule === '/' || targetPath.startsWith(rule));
    return { status: blocked ? 'disallowed' : 'allowed', disallows };
  } catch (error) {
    return { status: 'unknown', reason: error.message };
  }
}

function saveRawHtml(dataDir, runId, type, key, html) {
  const capturedAt = nowIso();
  const relative = path.join(
    'raw',
    capturedAt.slice(0, 10),
    `metadata-run-${runId}`,
    `${safeFilePart(type)}-${safeFilePart(key)}.html.gz`,
  );
  const target = path.join(dataDir, relative);
  const compressed = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 6 });
  writeFileAtomic(target, compressed);
  return target;
}

async function readVersionsFromPage(page, sourceUrl) {
  const raw = await page.evaluate(() => {
    const root = document.querySelector('#chapter_textbook_version');
    if (!root) return { error: 'missing_version_container' };
    return Array.from(root.querySelectorAll('a')).map((el, index) => ({
      externalVersionId: el.getAttribute('versionid')
        || el.getAttribute('data-versionid')
        || el.getAttribute('data-version-id'),
      versionName: (el.textContent || '').replace(/\u00a0/g, ' ').trim(),
      className: el.getAttribute('class') || '',
      selected: el.classList.contains('selected'),
      urlTemplate: el.getAttribute('url'),
      href: el.getAttribute('href'),
      qbmid: el.getAttribute('data-qbmid'),
      sortOrder: index,
      attributes: Object.fromEntries(Array.from(el.attributes).map((item) => [item.name, item.value])),
    }));
  });
  if (raw?.error === 'missing_version_container') {
    throw new StopCrawlError('页面缺少版本选择区域 #chapter_textbook_version。', 'version_contract');
  }
  return normalizeVersionRecords((raw || []).map((item) => ({ ...item, sourceUrl })));
}

async function readTextbookState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#chapter_textbooks');
    if (!root) return { error: 'missing_textbook_container', loading: false, items: [] };
    const text = root.textContent || '';
    if (text.includes('加载中err')) return { error: 'textbook_list_error', loading: false, items: [] };
    const loading = text.includes('加载中');
    const items = Array.from(root.querySelectorAll('a')).map((el, index) => {
      const href = el.getAttribute('href') || '';
      const fromHref = href.match(/\/zj(\d+)\b/);
      return {
        externalTextbookId: el.getAttribute('chapter-id') || (fromHref ? fromHref[1] : null),
        textbookName: (el.textContent || '').replace(/\u00a0/g, ' ').trim(),
        href,
        qbmid: el.getAttribute('data-qbmid'),
        selected: el.classList.contains('selected'),
        className: el.getAttribute('class') || '',
        sortOrder: index,
        attributes: Object.fromEntries(Array.from(el.attributes).map((item) => [item.name, item.value])),
      };
    }).filter((item) => item.textbookName && !item.textbookName.includes('加载中'));
    return { loading, items, error: null };
  });
}

async function waitForTextbookList(page, { previousSignature, allowUnchanged, timeout }) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    const state = await readTextbookState(page);
    if (state.error === 'textbook_list_error') {
      throw new StopCrawlError('教材列表加载失败。', 'textbook_list_error');
    }
    if (state.error === 'missing_textbook_container' || state.loading) {
      lastError = state.error || 'loading';
      await sleep(120);
      continue;
    }
    const records = normalizeTextbookRecords(state.items, { allowEmpty: true });
    const signature = textbookListSignature(records);
    if (allowUnchanged || !previousSignature || signature !== previousSignature) {
      return records;
    }
    lastError = 'unchanged';
    await sleep(120);
  }
  throw new StopCrawlError(
    `等待教材列表签名变化超时（${lastError || 'unknown'}），可能发生页面契约变化。`,
    'textbook_list_timeout',
  );
}

async function fetchTextbooksForVersion(page, version, options) {
  const requestUrl = assertAllowedUrl(buildChapterTextbooksUrl(version, options), ALLOWED_PAGE_HOSTS);
  const payload = await page.evaluate(async (href) => {
    try {
      const response = await fetch(href, {
        credentials: 'include',
        headers: {
          Accept: 'text/html, */*;q=0.1',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      return { status: response.status, text: await response.text(), error: null };
    } catch (error) {
      return { status: 0, text: '', error: String(error && error.message ? error.message : error) };
    }
  }, requestUrl);
  if (payload.error) throw new Error(`教材列表接口失败：${payload.error}`);
  if ([401, 403].includes(payload.status)) {
    throw new StopCrawlError(`HTTP ${payload.status}，任务已熔断。`, `http_${payload.status}`);
  }
  if (payload.status >= 400) throw new Error(`教材列表接口返回 HTTP ${payload.status}`);
  const protection = classifyHtmlProtection(payload.text);
  if (protection.terminalBlock || (protection.transientChallenge && !protection.hasContent)) {
    throw new StopCrawlError(protectionStopMessage(protection), 'challenge');
  }
  const textbooks = parseTextbooksFromApiHtml(payload.text, {
    versionExternalId: version.externalVersionId,
    baseUrl: options.baseUrl,
    bankPath: options.bankPath,
    seedUrl: options.seedUrl,
    allowEmpty: true,
  });
  if (textbooks.length === 0) {
    throw new StopCrawlError(
      `版本 ${version.versionName} 的教材列表为空，可能发生接口契约变化。`,
      'textbook_contract',
    );
  }
  return textbooks;
}

async function selectVersion(page, version, gate, options, _previousSignature) {
  await gate.wait(`拉取版本教材 ${version.versionName}`);
  return fetchTextbooksForVersion(page, version, options);
}

async function readBootstrapChapter(page) {
  return page.evaluate(() => {
    const tree = document.querySelector('.tk-tree');
    if (!tree) return { error: 'missing_tree' };
    const first = tree.querySelector('li.tree-node[data-level="1"]');
    const bootstrap = first?.getAttribute('tree-id')
      || first?.querySelector(':scope > .tree-node-name[data-tree-id]')?.getAttribute('data-tree-id')
      || null;
    return {
      textbookTreeId: tree.getAttribute('tree-id'),
      bootstrapChapterExternalId: bootstrap,
    };
  });
}

async function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    const configured = process.env.PLAYWRIGHT_CORE_PATH;
    if (!configured) throw new Error('缺少 playwright-core。请先在 collector/ 目录运行 npm install。');
    try {
      const playwright = require(configured);
      console.warn(`[环境] 使用 PLAYWRIGHT_CORE_PATH=${configured}。`);
      return playwright;
    } catch {
      throw new Error(`无法加载 PLAYWRIGHT_CORE_PATH=${configured}。`);
    }
  }
}

async function runDiscovery(options) {
  if (!options.acknowledgeSourcePolicy) {
    throw new Error(
      '运行前必须传 --acknowledge-source-policy，确认已核对来源站规则、授权范围和内容使用边界。',
    );
  }

  const playwright = await loadPlaywright();
  ensureDir(options.dataDir);
  ensureDir(options.profileDir);
  const store = new MetadataStore(options.dbPath);
  let releaseLock;
  try {
    releaseLock = acquireLock(`${options.dbPath}.lock`);
  } catch (error) {
    store.close();
    throw error;
  }

  const runId = store.beginRun(options.seedUrl);
  const counters = {
    versionsSeen: 0,
    textbooksSeen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
  };
  const seenVersionIds = new Set();
  const seenTextbookIds = new Set();
  const allTextbooks = [];
  const gate = new PoliteGate(options.delayMin, options.delayMax);
  let context;
  let signalName = null;
  const onSigint = () => {
    signalName = 'SIGINT';
    console.warn('\n[停止] 收到 SIGINT，将在当前安全点结束。');
  };
  const onSigterm = () => {
    signalName = 'SIGTERM';
    console.warn('\n[停止] 收到 SIGTERM，将在当前安全点结束。');
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let finalStatus = 'success';
  let finalMessage = null;
  let report = null;
  const validation = emptyValidation();

  try {
    console.log(`[启动] metadata-run=${runId}，数据库：${options.dbPath}`);
    applyInitialChromeMode(options);
    console.log(`[环境] ${describeChromeMode(options)}，入口 ${options.seedUrl}`);
    const boot = async () => {
      const next = await launchCollectorContext(playwright, options);
      try {
        const createPage = createCollectorPageFactory(next, options);
        const robots = await inspectRobots(next, options);
        if (robots.status === 'disallowed') {
          throw new StopCrawlError('robots.txt 明确禁止访问目标题库路径。', 'robots_disallowed');
        }
        if (robots.status !== 'allowed') {
          console.warn(`[提醒] robots.txt 状态未知：${robots.reason || robots.status}。仅按已确认的授权范围运行。`);
        }
        const page = await createPage();
        await safeGoto(page, options.seedUrl, gate, options, '加载元数据入口页');
        await settleSourcePage(page, options, {
          contentSelector: '#chapter_textbook_version a[versionid]',
          label: '版本列表',
        });
        return { context: next, page };
      } catch (error) {
        await closeCollectorContext(next);
        throw error;
      }
    };
    let session;
    try {
      session = await boot();
    } catch (error) {
      if (!canFallbackToHeaded(options, error)) throw error;
      console.warn(`[环境] 无头被防护阻断，改用有头 Chrome 重试：${String(error.message).split('\n')[0]}`);
      options.headless = false;
      session = await boot();
    }
    context = session.context;
    const page = session.page;
    if (options.saveRaw) saveRawHtml(options.dataDir, runId, 'seed', 'entry', await page.content());

    const versions = await readVersionsFromPage(page, options.seedUrl);
    assertDiscoveryIds(versions, []);
    counters.versionsSeen = versions.length;
    console.log(`[版本] 发现 ${versions.length} 个版本`);

    for (const version of versions) {
      if (signalName) throw new StopCrawlError(`收到 ${signalName}，任务安全停止。`, 'signal');
      console.log(`[版本] ${version.versionName} (${version.externalVersionId})`);
      const listed = await selectVersion(page, version, gate, options);
      const textbooks = normalizeTextbookRecords(listed, {
        versionExternalId: version.externalVersionId,
        baseUrl: options.baseUrl,
        bankPath: options.bankPath,
        seedUrl: options.seedUrl,
        allowEmpty: true,
      });
      assertDiscoveryIds([version], textbooks);
      console.log(`[教材] ${version.versionName} 共 ${textbooks.length} 本`);
      if (options.saveRaw) {
        saveRawHtml(
          options.dataDir,
          runId,
          'version',
          version.externalVersionId,
          await page.content(),
        );
      }

      for (const textbook of textbooks) {
        if (signalName) throw new StopCrawlError(`收到 ${signalName}，任务安全停止。`, 'signal');
        if (!textbook.sourceUrl) {
          throw new StopCrawlError(
            `教材 ${textbook.textbookName} 缺少可追溯来源地址。`,
            'textbook_url_missing',
          );
        }
        console.log(
          `[教材] ${version.versionName} / ${textbook.textbookName} (${textbook.externalTextbookId}) ${textbook.sourceUrl || textbook.href || ''}`,
        );
        if (!isStableExternalId(textbook.bootstrapChapterExternalId)) {
          validation.missingBootstrapChapters.push({
            externalTextbookId: textbook.externalTextbookId,
            textbookName: textbook.textbookName,
          });
        }
        seenTextbookIds.add(String(textbook.externalTextbookId));
        allTextbooks.push(textbook);
      }

      const observedAt = nowIso();
      const saved = store.saveVersionGroup(version, textbooks, observedAt, runId);
      counters.inserted += saved.inserted;
      counters.updated += saved.updated;
      counters.unchanged += saved.unchanged;
      counters.textbooksSeen += textbooks.length;
      seenVersionIds.add(String(version.externalVersionId));
    }

    const idValidation = validateDiscovery(versions, allTextbooks);
    validation.missingIds = idValidation.missingIds;
    validation.duplicateIds = idValidation.duplicateIds;
    if (signalName === 'SIGINT' || signalName === 'SIGTERM') {
      throw new StopCrawlError(`收到 ${signalName}，任务安全停止。`, 'signal');
    }
    report = buildReport(store, {
      validation,
      counts: {
        inserted: counters.inserted,
        updated: counters.updated,
        unchanged: counters.unchanged,
      },
      unseen: store.unseenCandidates(seenVersionIds, seenTextbookIds),
    });
    console.log(formatReport(report));
    writeJsonOutput(options.jsonOutput, report);
  } catch (error) {
    counters.errors += 1;
    finalStatus = signalName === 'SIGINT' || signalName === 'SIGTERM'
      ? 'cancelled'
      : (error instanceof StopCrawlError ? 'blocked' : 'failed');
    finalMessage = error.message;
    try {
      report = buildReport(store, {
        validation,
        counts: {
          inserted: counters.inserted,
          updated: counters.updated,
          unchanged: counters.unchanged,
        },
      });
    } catch {}
    throw error;
  } finally {
    await closeCollectorContext(context);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    store.finishRun(runId, finalStatus, counters, finalMessage, report);
    store.close();
    releaseLock?.();
    console.log(`[完成] metadata-run=${runId} status=${finalStatus}`, counters);
  }
}

function printStatus(store, options) {
  const report = buildReport(store);
  console.log(formatReport(report));
  const status = store.status();
  if (status.recentRuns.length === 0) {
    console.log('暂无元数据发现记录。');
  } else {
    console.table(status.recentRuns);
  }
  writeJsonOutput(options.jsonOutput, report);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (options.statusOnly) {
      const store = new MetadataStore(options.dbPath);
      try { printStatus(store, options); } finally { store.close(); }
      return;
    }
    await runDiscovery(options);
  } catch (error) {
    console.error(`\n[错误] ${error.message}`);
    if (!options?.help) console.error('使用 --help 查看参数。');
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_SEED_URL,
  METADATA_TERMINAL_STATUSES,
  MetadataStore,
  PROVIDER,
  StopCrawlError,
  assertDiscoveryIds,
  BLOCK_TEXT_MARKERS,
  buildReport,
  applyInitialChromeMode,
  buildChapterTextbooksUrl,
  canFallbackToHeaded,
  chooseInitialHeadless,
  classifyProtectionState,
  closeCollectorContext,
  collectorPageIsBlank,
  collectorPageIsOpen,
  createCollectorPageFactory,
  describeChromeMode,
  dismissStaleCollectorTabs,
  formatReport,
  ensureMetadataSnapshotSchema,
  isStableExternalId,
  launchCollectorContext,
  minimizeCollectorWindow,
  minimizeCollectorWindowWithLog,
  newCollectorPage,
  lookupBootstrapChapter,
  lookupTextbookByNames,
  pickExactByName,
  readBootstrapChapter,
  readVersionsFromPage,
  selectVersion,
  waitForTextbookList,
  normalizeIsNew,
  normalizeTextbookRecords,
  normalizeVersionRecords,
  migrateMetadataSnapshotSchema,
  parseArgs,
  prepareCollectorPage,
  profileLooksWarm,
  parseBootstrapChapterFromHtml,
  parseGradeVolume,
  decodeHtmlEntities,
  parseTextbooksFromApiHtml,
  parseTextbooksFromHtml,
  parseVersionsFromHtml,
  settleSourcePage,
  textbookListSignature,
  usage,
  validateDiscovery,
};

if (require.main === module) {
  main();
}
