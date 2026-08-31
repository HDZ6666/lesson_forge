#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const {
  migrateRunSnapshotSchema,
  RUN_CHECKPOINT_TABLE,
  SNAPSHOT_TABLES,
} = require('./lib/run_snapshots.cjs');

const {
  DEFAULT_SEED_URL,
  MetadataStore,
  applyInitialChromeMode,
  canFallbackToHeaded,
  classifyProtectionState,
  closeCollectorContext,
  createCollectorPageFactory,
  describeChromeMode,
  launchCollectorContext,
  lookupBootstrapChapter,
  lookupTextbookByNames,
  pickExactByName,
  readBootstrapChapter,
  readVersionsFromPage,
  selectVersion,
  settleSourcePage,
  waitForTextbookList,
  textbookListSignature,
  normalizeTextbookRecords,
  isStableExternalId,
} = require('./zujuan_metadata_sync.cjs');

const PROVIDER = 'zujuan';
const DEFAULT_BASE_URL = 'https://zujuan.xkw.com';
const DEFAULT_TEXTBOOK_ID = '260617';
const DEFAULT_CHAPTER_ID = '261314';
const QUESTION_LIST_API_PATH = '/zujuan-api/question/list';
const SOURCE_CONTENT_SELECTOR = '.tk-tree li.tree-node, .tk-quest-item, .quest-content .quesroot, #chapter_textbook_version';
const LIST_CONTENT_SELECTOR = '.tk-quest-item, .test-list, .topic-ctrl-bar, .tk-pager';
// Answer/analysis are deliberately tracked separately from the historical
// `solution_html` compatibility field.  Only the first value is a positive
// assertion that the current page exposed public content; the other values
// describe why no separated content was persisted.
const ANSWER_STATUSES = Object.freeze([
  'not_collected',
  'not_visible',
  'login_required',
  'public_captured',
]);
const SITE_PAGE_LIMIT = 1000;
const MAX_CHECKPOINT_PAGE = 1_000_000;
const MAX_WORKERS = 8;
const DEFAULT_NAMED_BOOK_WORKERS = 4;
const RESUME_TRANSIENT_MARKERS = Object.freeze([
  'timeouterror',
  'timeout',
  '超时',
  'econnreset',
  'econnrefused',
  'enotfound',
  'connection reset',
  'connection closed',
  'connection timed out',
  'browser has been closed',
  'target page, context or browser has been closed',
  'target closed',
  'socket closed',
  '连接重置',
  '连接关闭',
  '连接超时',
  'socket hang up',
  'etimedout',
  'eai_again',
  'net::err_',
  'err_connection_reset',
  'err_connection_closed',
  'err_connection_timed_out',
  'err_network_changed',
  'network error',
  '网络错误',
  'http 408',
  'http_408',
  'http 429',
  'http_429',
  'http 500',
  'http_500',
  'http 502',
  'http_502',
  'http 503',
  'http_503',
  'http 504',
  'http_504',
]);
const RESUME_DETERMINISTIC_MARKERS = Object.freeze([
  'challenge',
  'captcha',
  '验证码',
  '安全验证',
  '异常访问',
  '访问过于频繁',
  'robots',
  'robot.txt',
  '授权',
  '未授权',
  '登录 required',
  'login required',
  'unauthorized',
  'authorization',
  'access denied',
  'forbidden',
  'blocked',
  'policy',
  'http 401',
  'http_401',
  'http 403',
  'http_403',
  '契约',
  'contract',
  '结构变化',
  '页面结构',
  'catalog_not_found',
  'host_not_allowed',
  'tree_timeout',
  'pager_contract',
  'detail_contract',
  'contract_empty',
  'pagination_loop',
  'structure changed',
  'structural change',
  'schema changed',
  '目录树未出现',
  '没有解析到教材目录',
]);
const ALLOWED_PAGE_HOSTS = new Set(['zujuan.xkw.com']);
const ALLOWED_ASSET_HOSTS = new Set([
  'staticzujuan.xkw.com',
  'img.xkw.com',
  'zujuan.xkw.com',
]);

const SCENE_IDS = Object.freeze({
  '预习': 17,
  '作业': 18,
  '单元测': 19,
  '阶段检测': 20,
  '期中': 21,
  '期末': 22,
  '开学考': 23,
  '模拟': 27,
  '真题': 28,
  '学业考': 29,
  '假期': 30,
  '竞赛': 31,
  '自主招生': 32,
});

const QUESTION_TYPE_IDS = Object.freeze({
  '单选题': 1101,
  '填空题': 1102,
  '解答题': 1103,
  '多选题': 1104,
  '判断题': 1105,
});

const DIFFICULTY_IDS = Object.freeze({
  '容易': 1,
  '适中': 2,
  '困难': 3,
});

const CATEGORY_IDS = Object.freeze({
  '典型题': 4081,
  '压轴题': 4802,
  '同步题': 3,
  '课本原题': 4809,
});

const SORT_IDS = Object.freeze({
  '综合': 0,
  '最热': 1,
  '最新': 2,
});

const SLIDER_TEXT_MARKERS = [
  '请按住滑块',
  '滑动验证',
  '访问验证',
  '拖动滑块完成拼图',
];

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

// node:sqlite deliberately rejects `undefined` bind values.  Parsed pages
// are allowed to omit optional fields, so normalize every value at the store
// boundary instead of letting one sparse provider record abort a whole page.
function sqliteValue(value, fallback = null) {
  return value === undefined ? fallback : value;
}

function jsonValue(value, fallback = '{}') {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : encoded;
  } catch {
    return fallback;
  }
}

function normalizeAnswerStatus(value, fallback = 'not_collected') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'public' || normalized === 'available') return 'public_captured';
  if (ANSWER_STATUSES.includes(normalized)) return normalized;
  return fallback;
}

function hasPublicSolutionField(value) {
  return value != null && String(value).trim() !== '';
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

function resolveMappedId(value, mapping, optionName) {
  if (value == null) return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  if (Object.prototype.hasOwnProperty.call(mapping, value)) return mapping[value];
  throw new Error(
    `${optionName} 不支持“${value}”，可选值：${Object.keys(mapping).join('、')}，也可直接传数字 ID。`,
  );
}

function parsePositiveInt(value, optionName, { allowZero = false } = {}) {
  const parsed = Number(value);
  const valid = Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  if (!valid) throw new Error(`${optionName} 必须是${allowZero ? '非负' : '正'}整数。`);
  return parsed;
}

function usage() {
  return `
公开题库同步工具（默认仅抓取第五章第 1 页）

用法：
  cd collector && npm run sync:zujuan -- --acknowledge-source-policy [选项]

核心选项：
  --version-name <名称>       版本原文，例如 北师大版（不与「北师大版（2012）」合并）
  --textbook-name <名称>      教材原文，例如 九年级上册；与 --version-name 同时提供时抓该书全部目录
  --chapter-id <id>           章节目录 ID，可重复；未传且未传教材参数时默认 261314
  --textbook-id <id>          教材来源 ID；优先使用 source_textbooks 的入口章节，缺失时使用教材来源 ID
  --seed-url <url>            名称选书时的入口页；默认北师大九上已知章节页
  --catalog-level <n>         目录层级：1=章、2=小节、3=知识点；可重复
  --catalog-id <id>           只同步指定目录节点；可重复
  --all-catalogs              遍历所选层级全部节点（需配 --catalog-level）
  --within-chapter <id>       批量目录仅保留指定章及其后代；可重复
  --start-page <n>            起始页；默认 1
  --max-pages <n>             本次最多抓取页数；默认 1
  --limit <n>                 最多处理多少道题；0 表示不限，默认 0
  --workers <n>               并行工作标签数；1-8，全书模式默认 4（按章分配，同一 Chrome）
  --list-only                 只解析列表，不访问题目详情页
  --refresh-details           已存在且内容未变的题目也重新抓详情
  --include-visible-solutions 仅采集详情页当前公开可见的答案/解析（默认关闭）
  --download-assets           下载题图和公式到 data/zujuan/assets（全书模式默认开启）
  --no-download-assets        只记录图片 URL，不落盘
  --no-save-raw               不保存 gzip 原始页面快照
  --no-resume                 忽略已完成页断点
  --resume-run-id <id>        从指定的不可变不完整运行续采（不能与 --no-resume 同时使用）

筛选选项：
  --scene <名称或ID>          预习、作业、单元测、阶段检测、期中等
  --question-type <名称或ID>  单选题、多选题、填空题、解答题、判断题
  --difficulty <名称或ID>     容易、适中、困难
  --category <名称或ID>       典型题、压轴题、同步题、课本原题
  --year <yyyy>               年份
  --fresh                     只看新题
  --sort <名称或ID>           综合、最热、最新；默认最新

运行选项：
  --headful                   显示 Chrome 窗口（默认无头；冷档案或防护阻断时会自动改有头）
  --delay-min <ms>            每次页面请求最小间隔；默认 2200
  --delay-max <ms>            每次页面请求最大间隔；默认 3800
  --timeout <ms>              页面超时；默认 30000
  --db <path>                 SQLite 路径；默认 data/zujuan.sqlite3
  --data-dir <path>           快照/素材目录；默认 data/zujuan
  --profile-dir <path>        独立浏览器配置目录；默认 .cache/zujuan-sync-profile
  --acknowledge-source-policy 确认已核对来源站规则/授权范围（运行必需）
  --status                    只查看最近同步状态，不访问网站
  --catalog-progress          输出章/节/知识点已抓与共计的 JSON 树，不访问网站
  --help                      显示帮助

传 --textbook-id 或同时提供 --version-name 与 --textbook-name 时：默认抓该书全部章/节/知识点列表，并从列表页下载题图/公式；列表缺题干或图片时才打开详情。--list-only 禁止详情，--refresh-details 强制详情。滑块验证会停止，不会自动拖。
安全约束：同一 Chrome 档案、多标签按章并行，每个标签独立限速；403、验证码、JS 挑战或页面契约变化会立即停止全部标签。
`;
}

function applyFullBookCollectionDefaults(options) {
  if (options.catalogIds.length === 0) {
    options.allCatalogs = true;
    if (options.catalogLevels.length === 0) options.catalogLevels = [1, 2, 3];
  }
  if (!options.maxPagesProvided) options.maxPages = SITE_PAGE_LIMIT;
  if (!options.downloadAssetsProvided) options.downloadAssets = true;
  if (!options.detailsProvided && !options.refreshDetails) {
    options.details = false;
    options.detailFallback = true;
  }
  return options;
}

function listNeedsDetailFallback(question) {
  const html = String(question?.contentHtml || '');
  const text = String(question?.plainText || '').trim();
  if (!html && !text) return true;
  if (/<img\b/i.test(html) && (!Array.isArray(question.assets) || question.assets.length === 0)) return true;
  return false;
}

function shouldFetchQuestionDetail(question, existing, options, listContentUnchanged) {
  if (options.refreshDetails) return true;
  if (options.details) {
    return !existing || !existing.detail_fetched || !listContentUnchanged;
  }
  if (options.detailFallback) return listNeedsDetailFallback(question);
  return false;
}

function parseArgs(argv) {
  const cwd = process.cwd();
  const projectRoot = path.resolve(__dirname);
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    bankPath: 'czsx',
    chapterIds: [],
    chapterIdProvided: false,
    textbookId: DEFAULT_TEXTBOOK_ID,
    textbookIdProvided: false,
    versionName: null,
    textbookName: null,
    namedTextbook: false,
    seedUrl: DEFAULT_SEED_URL,
    catalogLevels: [],
    catalogIds: [],
    allCatalogs: false,
    withinChapterIds: [],
    startPage: 1,
    maxPages: 1,
    maxPagesProvided: false,
    delayMinProvided: false,
    delayMaxProvided: false,
    limit: 0,
    workers: 1,
    workersProvided: false,
    details: true,
    detailsProvided: false,
    refreshDetails: false,
    detailFallback: false,
    downloadAssets: false,
    downloadAssetsProvided: false,
    saveRaw: true,
    resume: true,
    noResumeProvided: false,
    resumeRunId: null,
    resumeRunIdProvided: false,
    headless: true,
    delayMin: 2200,
    delayMax: 3800,
    timeout: 30000,
    dbPath: path.resolve(projectRoot, 'data/zujuan.sqlite3'),
    dataDir: path.resolve(projectRoot, 'data/zujuan'),
    profileDir: path.resolve(projectRoot, '.cache/zujuan-sync-profile'),
    acknowledgeSourcePolicy: false,
    statusOnly: false,
    catalogProgress: false,
    includeVisibleSolutions: false,
    sceneId: null,
    sceneName: null,
    questionTypeId: null,
    questionTypeName: null,
    difficultyId: null,
    difficultyName: null,
    categoryId: null,
    categoryName: null,
    year: null,
    fresh: false,
    sortId: 2,
    sortName: '最新',
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
      case '--chapter-id': {
        const value = needValue(i, arg);
        options.chapterIds.push(String(parsePositiveInt(value, arg)));
        options.chapterIdProvided = true;
        i += 1;
        break;
      }
      case '--textbook-id': {
        const value = needValue(i, arg);
        const textbookId = String(value).trim();
        if (!isStableExternalId(textbookId)) {
          throw new Error(`${arg} 必须是稳定来源 ID（仅支持字母、数字、点、下划线和连字符）。`);
        }
        options.textbookId = textbookId;
        options.textbookIdProvided = true;
        i += 1;
        break;
      }
      case '--version-name':
        options.versionName = needValue(i, arg);
        i += 1;
        break;
      case '--textbook-name':
        options.textbookName = needValue(i, arg);
        i += 1;
        break;
      case '--seed-url':
        options.seedUrl = needValue(i, arg);
        i += 1;
        break;
      case '--catalog-level': {
        const value = parsePositiveInt(needValue(i, arg), arg);
        if (![1, 2, 3].includes(value)) throw new Error('--catalog-level 只能是 1、2 或 3。');
        options.catalogLevels.push(value);
        i += 1;
        break;
      }
      case '--catalog-id': {
        const value = needValue(i, arg);
        options.catalogIds.push(String(parsePositiveInt(value, arg)));
        i += 1;
        break;
      }
      case '--all-catalogs':
        options.allCatalogs = true;
        break;
      case '--within-chapter': {
        const value = needValue(i, arg);
        options.withinChapterIds.push(String(parsePositiveInt(value, arg)));
        i += 1;
        break;
      }
      case '--start-page':
        options.startPage = parsePositiveInt(needValue(i, arg), arg);
        i += 1;
        break;
      case '--max-pages':
        options.maxPages = parsePositiveInt(needValue(i, arg), arg);
        options.maxPagesProvided = true;
        i += 1;
        break;
      case '--limit':
        options.limit = parsePositiveInt(needValue(i, arg), arg, { allowZero: true });
        i += 1;
        break;
      case '--workers':
        options.workers = parsePositiveInt(needValue(i, arg), arg);
        options.workersProvided = true;
        i += 1;
        break;
      case '--scene': {
        const value = needValue(i, arg);
        options.sceneId = resolveMappedId(value, SCENE_IDS, arg);
        options.sceneName = Object.keys(SCENE_IDS).find((key) => SCENE_IDS[key] === options.sceneId) || value;
        i += 1;
        break;
      }
      case '--question-type': {
        const value = needValue(i, arg);
        options.questionTypeId = resolveMappedId(value, QUESTION_TYPE_IDS, arg);
        options.questionTypeName = Object.keys(QUESTION_TYPE_IDS)
          .find((key) => QUESTION_TYPE_IDS[key] === options.questionTypeId) || value;
        i += 1;
        break;
      }
      case '--difficulty': {
        const value = needValue(i, arg);
        options.difficultyId = resolveMappedId(value, DIFFICULTY_IDS, arg);
        options.difficultyName = Object.keys(DIFFICULTY_IDS)
          .find((key) => DIFFICULTY_IDS[key] === options.difficultyId) || value;
        i += 1;
        break;
      }
      case '--category': {
        const value = needValue(i, arg);
        options.categoryId = resolveMappedId(value, CATEGORY_IDS, arg);
        options.categoryName = Object.keys(CATEGORY_IDS)
          .find((key) => CATEGORY_IDS[key] === options.categoryId) || value;
        i += 1;
        break;
      }
      case '--year': {
        const value = parsePositiveInt(needValue(i, arg), arg);
        if (value < 1900 || value > 2200) throw new Error('--year 超出合理范围。');
        options.year = value;
        i += 1;
        break;
      }
      case '--sort': {
        const value = needValue(i, arg);
        options.sortId = resolveMappedId(value, SORT_IDS, arg);
        options.sortName = Object.keys(SORT_IDS).find((key) => SORT_IDS[key] === options.sortId) || value;
        i += 1;
        break;
      }
      case '--fresh':
        options.fresh = true;
        break;
      case '--list-only':
        options.details = false;
        options.detailsProvided = true;
        options.detailFallback = false;
        break;
      case '--refresh-details':
        options.refreshDetails = true;
        options.details = true;
        options.detailsProvided = true;
        break;
      case '--download-assets':
        options.downloadAssets = true;
        options.downloadAssetsProvided = true;
        break;
      case '--no-download-assets':
        options.downloadAssets = false;
        options.downloadAssetsProvided = true;
        break;
      case '--no-save-raw':
        options.saveRaw = false;
        break;
      case '--no-resume':
        options.resume = false;
        options.noResumeProvided = true;
        break;
      case '--resume-run-id': {
        const value = needValue(i, arg);
        options.resumeRunId = parsePositiveInt(value, arg);
        options.resumeRunIdProvided = true;
        options.resume = true;
        i += 1;
        break;
      }
      case '--headful':
        options.headless = false;
        break;
      case '--delay-min':
        options.delayMin = parsePositiveInt(needValue(i, arg), arg, { allowZero: true });
        options.delayMinProvided = true;
        i += 1;
        break;
      case '--delay-max':
        options.delayMax = parsePositiveInt(needValue(i, arg), arg, { allowZero: true });
        options.delayMaxProvided = true;
        i += 1;
        break;
      case '--timeout':
        options.timeout = parsePositiveInt(needValue(i, arg), arg);
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
      case '--acknowledge-source-policy':
        options.acknowledgeSourcePolicy = true;
        break;
      case '--include-visible-solutions':
        options.includeVisibleSolutions = true;
        break;
      case '--status':
        options.statusOnly = true;
        break;
      case '--catalog-progress':
        options.catalogProgress = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  if ((options.versionName && !options.textbookName) || (!options.versionName && options.textbookName)) {
    throw new Error('必须同时提供 --version-name 和 --textbook-name。');
  }
  if (options.versionName && options.textbookName) {
    options.namedTextbook = true;
    options.versionName = String(options.versionName).trim();
    options.textbookName = String(options.textbookName).trim();
    if (!options.chapterIdProvided && !options.textbookIdProvided) options.chapterIds = [];
    if (!options.delayMinProvided) options.delayMin = 3500;
    if (!options.delayMaxProvided) options.delayMax = 6000;
    if (!options.workersProvided) options.workers = DEFAULT_NAMED_BOOK_WORKERS;
    applyFullBookCollectionDefaults(options);
  }
  if (options.textbookIdProvided) {
    applyFullBookCollectionDefaults(options);
  }
  if (options.chapterIds.length === 0 && !options.textbookIdProvided && !options.namedTextbook) {
    options.chapterIds.push(DEFAULT_CHAPTER_ID);
  }
  if (options.delayMax < options.delayMin) throw new Error('--delay-max 不能小于 --delay-min。');
  if (options.resumeRunIdProvided && options.noResumeProvided) {
    throw new Error('--resume-run-id 不能与 --no-resume 同时使用。');
  }
  if (options.maxPages > SITE_PAGE_LIMIT) {
    throw new Error(`--max-pages 不能超过站点页面上限 ${SITE_PAGE_LIMIT}。`);
  }
  if (options.workers > MAX_WORKERS) {
    throw new Error(`--workers 不能超过 ${MAX_WORKERS}。`);
  }
  options.catalogLevels = [...new Set(options.catalogLevels)].sort();
  options.catalogIds = [...new Set(options.catalogIds)];
  options.withinChapterIds = [...new Set(options.withinChapterIds)];
  if (options.allCatalogs && options.catalogLevels.length === 0) {
    throw new Error('--all-catalogs 必须至少配一个 --catalog-level。');
  }
  return options;
}

function parseScopeObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalScopeArray(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .filter((item) => item != null && String(item).trim() !== '')
    .map((item) => String(item).trim()))].sort();
}

function canonicalScopeBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function canonicalScopeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canonicalScopeFacet(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) return String(value);
  const id = value.id == null || value.id === '' ? null : String(value.id);
  const name = value.name == null || value.name === '' ? null : String(value.name);
  return { id, name };
}

/**
 * Keep only the range/meaning fields that must remain identical across a
 * resume.  Operational knobs (workers, delays, profile and raw-page output)
 * deliberately do not participate in this identity.
 */
function normalizeResumeScope(scope) {
  const raw = parseScopeObject(scope);
  const filters = raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)
    ? raw.filters
    : {};
  const details = canonicalScopeBoolean(raw.details, true);
  const downloadAssets = canonicalScopeBoolean(raw.downloadAssets, false);
  const textbookArray = Array.isArray(raw.textbookIds)
    ? raw.textbookIds
    : (Array.isArray(raw.textbookExternalIds) ? raw.textbookExternalIds : []);
  const chapterArray = Array.isArray(raw.chapterIds)
    ? raw.chapterIds
    : (raw.chapterId == null ? [] : [raw.chapterId]);
  return {
    textbookId: String(raw.textbookId ?? raw.textbookExternalId
      ?? (textbookArray.length === 1 ? textbookArray[0] : '')).trim(),
    chapterIds: canonicalScopeArray(chapterArray),
    catalogLevels: canonicalScopeArray(raw.catalogLevels),
    catalogIds: canonicalScopeArray(raw.catalogIds),
    allCatalogs: canonicalScopeBoolean(raw.allCatalogs, false),
    withinChapterIds: canonicalScopeArray(raw.withinChapterIds),
    filters: {
      scene: canonicalScopeFacet(filters.scene),
      questionType: canonicalScopeFacet(filters.questionType),
      difficulty: canonicalScopeFacet(filters.difficulty),
      category: canonicalScopeFacet(filters.category),
      year: filters.year == null || filters.year === '' ? null : String(filters.year),
      fresh: canonicalScopeBoolean(filters.fresh, false),
      sort: canonicalScopeFacet(filters.sort, { id: '2', name: '最新' }),
    },
    startPage: canonicalScopeNumber(raw.startPage, 1),
    maxPages: canonicalScopeNumber(raw.maxPages, 1),
    limit: canonicalScopeNumber(raw.limit, 0),
    details,
    detailFallback: canonicalScopeBoolean(raw.detailFallback, false),
    refreshDetails: canonicalScopeBoolean(raw.refreshDetails, false),
    downloadAssets,
    requireDetails: canonicalScopeBoolean(
      raw.requireDetails,
      details || canonicalScopeBoolean(raw.refreshDetails, false),
    ),
    requireAssets: canonicalScopeBoolean(raw.requireAssets, downloadAssets),
    includeVisibleSolutions: canonicalScopeBoolean(raw.includeVisibleSolutions, false),
  };
}

function resumeScopeDifferences(left, right) {
  const first = normalizeResumeScope(left);
  const second = normalizeResumeScope(right);
  const differences = [];
  for (const key of Object.keys(first)) {
    if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) differences.push(key);
  }
  return differences;
}

function scopeTextbookIds(scope) {
  const raw = parseScopeObject(scope);
  const values = [raw.textbookId, raw.textbookExternalId];
  for (const key of ['textbookIds', 'textbookExternalIds']) {
    if (Array.isArray(raw[key])) values.push(...raw[key]);
  }
  return [...new Set(values
    .filter((value) => value != null && String(value).trim() !== '')
    .map((value) => String(value).trim()))];
}

function resumeErrorMarkerText(run, errors = []) {
  return [
    run?.message,
    ...errors.flatMap((error) => [error?.error_code, error?.stage, error?.message]),
  ].filter((value) => value != null && String(value).trim() !== '').join('\n').toLowerCase();
}

function isTransientResumeError(run, errors = []) {
  const text = resumeErrorMarkerText(run, errors);
  if (!text) return false;
  if (RESUME_DETERMINISTIC_MARKERS.some((marker) => text.includes(marker.toLowerCase()))) return false;
  return RESUME_TRANSIENT_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function hasDeterministicResumeError(run, errors = []) {
  const text = resumeErrorMarkerText(run, errors);
  return RESUME_DETERMINISTIC_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function sqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function snapshotTableCounts(db, runId, textbookExternalId) {
  const result = {};
  const fieldNames = [
    ['sync_run_catalog_items', 'catalogCount'],
    ['sync_run_question_items', 'questionCount'],
    ['sync_run_question_catalogs', 'questionCatalogCount'],
    ['sync_run_question_tags', 'questionTagCount'],
    ['sync_run_question_assets', 'questionAssetCount'],
  ];
  for (const [table, field] of fieldNames) {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(table);
    result[field] = exists
      ? Number(db.prepare(`
        SELECT COUNT(*) AS n FROM ${sqlIdentifier(table)}
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      `).get(Number(runId), PROVIDER, String(textbookExternalId)).n || 0)
      : 0;
  }
  return result;
}

function sourceRunErrors(db, runId) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_errors' LIMIT 1",
  ).get();
  if (!exists) return [];
  return db.prepare(`
    SELECT error_code, stage, message
    FROM sync_errors WHERE run_id = ? ORDER BY id ASC LIMIT 50
  `).all(Number(runId));
}

function resumeSourceError(message, code = 'resume_source_invalid') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate a sealed partial run before any of its rows are copied.  This is
 * intentionally usable by the API manager as well as the standalone CLI.
 */
function validateResumeSourceRunInDb(db, sourceRunId, targetScope) {
  const parsedRunId = Number(sourceRunId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) {
    throw resumeSourceError('resume-run-id 必须是正整数');
  }
  const run = db.prepare(`
    SELECT id, provider, started_at, finished_at, status, scope_json,
           pages_ok, questions_seen, error_count, message,
           snapshot_locked_at, snapshot_complete
    FROM sync_runs WHERE id = ?
  `).get(parsedRunId);
  if (!run) throw resumeSourceError(`来源运行 ${parsedRunId} 不存在`);
  if (String(run.provider || '') !== PROVIDER) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 来源提供方不受支持`);
  }
  if (!run.snapshot_locked_at) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 尚未锁定，不能续采`);
  }
  if (Number(run.snapshot_complete || 0) === 1) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 已是完整快照，不能作为续采来源`);
  }

  const target = normalizeResumeScope(targetScope);
  if (!target.textbookId) throw resumeSourceError('续采范围缺少 textbookId');
  const sourceScope = parseScopeObject(run.scope_json);
  const sourceScopeIds = scopeTextbookIds(sourceScope);
  if (sourceScopeIds.length !== 1 || sourceScopeIds[0] !== target.textbookId) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 教材范围与续采教材不匹配`);
  }
  const rowScopeIds = new Set();
  for (const table of SNAPSHOT_TABLES) {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(table);
    if (!exists) throw resumeSourceError(`来源运行 ${parsedRunId} 缺少 ${table} 快照表`);
    for (const row of db.prepare(`
      SELECT DISTINCT textbook_external_id
      FROM ${sqlIdentifier(table)} WHERE run_id = ? AND provider = ?
    `).all(parsedRunId, PROVIDER)) {
      if (row.textbook_external_id == null || String(row.textbook_external_id).trim() === '') {
        throw resumeSourceError(`来源运行 ${parsedRunId} 的 ${table} 含无教材归属的快照行`);
      }
      rowScopeIds.add(String(row.textbook_external_id));
    }
  }
  if ([...rowScopeIds].some((id) => id !== target.textbookId)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 含有其他教材快照，不能续采`);
  }
  if (rowScopeIds.size > 0 && !rowScopeIds.has(target.textbookId)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 没有教材 ${target.textbookId} 的快照`);
  }

  const differences = resumeScopeDifferences(sourceScope, targetScope);
  if (differences.length > 0) {
    throw resumeSourceError(
      `来源运行 ${parsedRunId} 的采集范围不匹配：${differences.join('、')}`,
    );
  }

  const errors = sourceRunErrors(db, parsedRunId);
  const status = String(run.status || '').trim().toLowerCase();
  // Naming a blocked run on the CLI is an explicit operator action.  Its
  // completed pages are still immutable and safe to inherit after the
  // operator has resolved/cool-downed the challenge.  Automatic retry code
  // must never select a blocked run; it only selects `interrupted` runs.
  if (!['interrupted', 'failed', 'blocked'].includes(status)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 状态 ${status || 'unknown'} 不允许续采`);
  }
  if (status === 'failed' && !isTransientResumeError(run, errors)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 不是可续采的瞬时错误`);
  }
  if (status === 'interrupted' && hasDeterministicResumeError(run, errors)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 包含确定性失败，不能续采`);
  }

  const counts = snapshotTableCounts(db, parsedRunId, target.textbookId);
  const inheritedSource = Number(sourceScope.resumeFromRunId || 0) > 0;
  if ((status === 'failed' && Number(run.pages_ok || 0) < 1 && !inheritedSource)
    || counts.catalogCount < 1
    || counts.questionCount < 1
    || counts.questionCatalogCount < 1) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 尚无可安全续采的完整页/部分快照`);
  }
  const orphanChecks = [
    [`${SNAPSHOT_TABLES[2]} 题目目录关系`, `
      SELECT 1 FROM sync_run_question_catalogs AS r
      WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
        AND (NOT EXISTS (
          SELECT 1 FROM sync_run_question_items AS q
          WHERE q.run_id = r.run_id AND q.provider = r.provider
            AND q.textbook_external_id = r.textbook_external_id
            AND q.question_external_id = r.question_external_id
        ) OR NOT EXISTS (
          SELECT 1 FROM sync_run_catalog_items AS c
          WHERE c.run_id = r.run_id AND c.provider = r.provider
            AND c.textbook_external_id = r.textbook_external_id
            AND c.catalog_external_id = r.catalog_external_id
        )) LIMIT 1
    `],
    [`${SNAPSHOT_TABLES[3]} 题目标签`, `
      SELECT 1 FROM sync_run_question_tags AS r
      WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_run_question_items AS q
          WHERE q.run_id = r.run_id AND q.provider = r.provider
            AND q.textbook_external_id = r.textbook_external_id
            AND q.question_external_id = r.question_external_id
        ) LIMIT 1
    `],
    [`${SNAPSHOT_TABLES[4]} 题目素材`, `
      SELECT 1 FROM sync_run_question_assets AS r
      WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_run_question_items AS q
          WHERE q.run_id = r.run_id AND q.provider = r.provider
            AND q.textbook_external_id = r.textbook_external_id
            AND q.question_external_id = r.question_external_id
        ) LIMIT 1
    `],
  ];
  for (const [label, query] of orphanChecks) {
    if (db.prepare(query).get(parsedRunId, PROVIDER, target.textbookId)) {
      throw resumeSourceError(`来源运行 ${parsedRunId} 的 ${label} 包含孤儿行`);
    }
  }
  return {
    run,
    scope: sourceScope,
    errors,
    counts,
    textbookExternalId: target.textbookId,
    resumable: true,
  };
}

function validateResumeSourceRun(dbPath, sourceRunId, targetScope) {
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    return validateResumeSourceRunInDb(db, sourceRunId, targetScope);
  } finally {
    try { db?.close(); } catch {}
  }
}

function copyResumeSnapshotRows(db, sourceRunId, targetRunId, textbookExternalId) {
  const sourceId = Number(sourceRunId);
  const targetId = Number(targetRunId);
  const textbookId = String(textbookExternalId);
  const copied = {};
  for (const table of SNAPSHOT_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all()
      .map((row) => String(row.name));
    const copyColumns = columns.filter((column) => column !== 'run_id');
    if (!columns.includes('run_id') || !columns.includes('provider')
      || !columns.includes('textbook_external_id')) {
      throw resumeSourceError(`来源运行快照表 ${table} 字段不完整`);
    }
    const insertColumns = ['run_id', ...copyColumns].map(sqlIdentifier).join(', ');
    const selectColumns = ['?', ...copyColumns.map(sqlIdentifier)].join(', ');
    const result = db.prepare(`
      INSERT INTO ${sqlIdentifier(table)} (${insertColumns})
      SELECT ${selectColumns}
      FROM ${sqlIdentifier(table)}
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
    `).run(targetId, sourceId, PROVIDER, textbookId);
    copied[table] = Number(result?.changes || 0);
  }
  return copied;
}

function normalizeCheckpointPage(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_CHECKPOINT_PAGE) {
    return fallback;
  }
  return parsed;
}

function checkpointFilterJson(scope) {
  const raw = parseScopeObject(scope);
  const filters = raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)
    ? raw.filters
    : {};
  return JSON.stringify(filters);
}

function checkpointScopeKey(catalogExternalId, filterJson) {
  return sha256(`${PROVIDER}|catalog:${String(catalogExternalId)}|${filterJson}`);
}

function checkpointChapterId(scope, catalogExternalId) {
  const raw = parseScopeObject(scope);
  const chapterIds = Array.isArray(raw.chapterIds)
    ? raw.chapterIds
    : (raw.chapterId == null ? [] : [raw.chapterId]);
  const chapterId = chapterIds.find((value) => value != null && String(value).trim() !== '');
  return String(chapterId == null ? catalogExternalId : chapterId).trim();
}

function insertRunCheckpointRows(db, targetRunId, rows) {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(RUN_CHECKPOINT_TABLE);
  if (!tableExists) throw resumeSourceError(`缺少 ${RUN_CHECKPOINT_TABLE} 表`);
  const insert = db.prepare(`
    INSERT INTO ${sqlIdentifier(RUN_CHECKPOINT_TABLE)} (
      run_id, scope_key, provider, chapter_id, filter_json,
      last_completed_page, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, scope_key) DO UPDATE SET
      provider = excluded.provider,
      chapter_id = excluded.chapter_id,
      filter_json = excluded.filter_json,
      last_completed_page = MAX(
        ${sqlIdentifier(RUN_CHECKPOINT_TABLE)}.last_completed_page,
        excluded.last_completed_page
      ),
      updated_at = excluded.updated_at
  `);
  let inserted = 0;
  for (const row of rows || []) {
    const scopeKey = String(row?.scopeKey || row?.scope_key || '').trim();
    const chapterId = String(row?.chapterId || row?.chapter_id || '').trim();
    const filterJson = String(row?.filterJson || row?.filter_json || '{}');
    if (!scopeKey || !chapterId) continue;
    const page = normalizeCheckpointPage(
      row?.lastCompletedPage ?? row?.last_completed_page,
      null,
    );
    if (page == null) throw resumeSourceError(`checkpoint 页码超出安全范围：${page}`);
    insert.run(
      Number(targetRunId),
      scopeKey,
      PROVIDER,
      chapterId,
      filterJson,
      page,
      String(row?.updatedAt || row?.updated_at || nowIso()),
    );
    inserted += 1;
  }
  return inserted;
}

/**
 * Clone checkpoints owned by a sealed source run.  Runs created before
 * run-scoped checkpoints existed (notably task 12/run 19) are reconstructed
 * only from that run's own sync_progress rows.  The mutable global
 * sync_checkpoints table is intentionally never consulted here.
 */
function copyResumeRunCheckpoints(db, sourceRunId, targetRunId, sourceScope) {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(RUN_CHECKPOINT_TABLE);
  if (!tableExists) throw resumeSourceError(`缺少 ${RUN_CHECKPOINT_TABLE} 表`);

  const sourceRows = db.prepare(`
    SELECT scope_key, provider, chapter_id, filter_json,
           last_completed_page, updated_at
    FROM ${sqlIdentifier(RUN_CHECKPOINT_TABLE)}
    WHERE run_id = ? AND provider = ?
    ORDER BY scope_key ASC
  `).all(Number(sourceRunId), PROVIDER);
  if (sourceRows.length > 0) {
    const normalized = sourceRows.map((row) => {
      const scopeKey = String(row.scope_key || '').trim();
      const chapterId = String(row.chapter_id || '').trim();
      if (!scopeKey || !chapterId || !String(row.filter_json || '').trim()) {
        throw resumeSourceError(`来源运行 ${sourceRunId} 的 run checkpoint 字段不完整`);
      }
      const page = normalizeCheckpointPage(row.last_completed_page, null);
      if (page == null) {
        throw resumeSourceError(`来源运行 ${sourceRunId} 的 checkpoint 页码超出安全范围`);
      }
      return {
        scopeKey,
        chapterId,
        filterJson: String(row.filter_json),
        lastCompletedPage: page,
        updatedAt: row.updated_at,
      };
    });
    return {
      source: 'run',
      count: insertRunCheckpointRows(db, targetRunId, normalized),
    };
  }

  const progressExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_progress' LIMIT 1",
  ).get();
  if (!progressExists) return { source: 'none', count: 0 };

  const filterJson = checkpointFilterJson(sourceScope);
  const chapterId = checkpointChapterId(sourceScope, '');
  const byScopeKey = new Map();
  for (const row of db.prepare(`
    SELECT catalog_external_id, current_page, updated_at
    FROM sync_progress
    WHERE run_id = ? AND catalog_external_id IS NOT NULL
    ORDER BY worker_id ASC
  `).all(Number(sourceRunId))) {
    const catalogId = String(row.catalog_external_id || '').trim();
    if (!catalogId) continue;
    const page = normalizeCheckpointPage(row.current_page, null);
    // A malformed progress row is unknown progress, never permission to
    // skip pages.  The catalog will therefore replay from page 1.
    if (page == null) continue;
    const scopeKey = checkpointScopeKey(catalogId, filterJson);
    const previous = byScopeKey.get(scopeKey);
    if (previous && previous.lastCompletedPage >= page) continue;
    byScopeKey.set(scopeKey, {
      scopeKey,
      chapterId: chapterId || catalogId,
      filterJson,
      lastCompletedPage: page,
      updatedAt: row.updated_at || nowIso(),
    });
  }
  return {
    source: 'legacy-progress',
    count: insertRunCheckpointRows(db, targetRunId, [...byScopeKey.values()]),
  };
}

function isResumablePartialRun(summary) {
  const status = String(summary?.status || '').trim().toLowerCase();
  if (status !== 'interrupted') return false;
  const lockedAt = summary?.snapshotLockedAt ?? summary?.snapshot_locked_at;
  if (lockedAt == null || String(lockedAt).trim() === '') return false;
  if (summary?.snapshotComplete === true || Number(summary?.snapshot_complete || 0) === 1) {
    return false;
  }
  const coreCounts = [
    summary?.catalogCount ?? summary?.catalogItemCount ?? 0,
    summary?.questionCount ?? summary?.questionItemCount ?? 0,
    summary?.questionCatalogCount ?? 0,
  ].map((value) => Number(value));
  if (coreCounts.some((value) => !Number.isFinite(value) || value < 0)) return false;
  // A resumable clone must contain every core relation independently.
  // Summing the counters could incorrectly accept e.g. catalogs=3 while
  // questions/relations are empty, which cannot form a usable page snapshot.
  if (coreCounts.some((value) => value <= 0)) return false;
  const errors = Array.isArray(summary?.errors)
    ? summary.errors.map((error) => ({
      error_code: error.errorCode ?? error.error_code,
      stage: error.stage,
      message: error.message,
    }))
    : [];
  return !hasDeterministicResumeError({ message: summary.message }, errors);
}

async function loadCatalogTree(page, url, gate, options) {
  let lastTreeError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await safeGoto(page, url, gate, options, '加载教材目录');
      await page.locator('.tk-tree li.tree-node').first().waitFor({
        state: 'attached',
        timeout: options.timeout,
      });
      return;
    } catch (error) {
      if (error instanceof StopCrawlError && error.code !== 'tree_timeout') throw error;
      lastTreeError = error;
      if (attempt === 3) break;
      console.warn(`[重试] 目录树未就绪（${attempt}/3）：${String(error.message).split('\n')[0]}`);
      await sleep(1500 * attempt);
    }
  }
  try { await detectBlockedPage(page); } catch (blocked) {
    if (blocked instanceof StopCrawlError) throw blocked;
  }
  throw new StopCrawlError(
    `教材目录树未出现：${String(lastTreeError?.message || '').split('\n')[0]}`,
    'tree_timeout',
  );
}

async function resolveNamedTextbook(page, gate, options) {
  const cached = lookupTextbookByNames(options.dbPath, options.versionName, options.textbookName);
  if (cached) {
    console.log(
      `[教材] 采集库命中 ${cached.versionName} / ${cached.textbookName}，入口章节 ${cached.bootstrapChapterExternalId}`,
    );
    options.textbookId = cached.externalTextbookId;
    options.chapterIds = [cached.bootstrapChapterExternalId];
    await loadCatalogTree(page, buildListUrl(options, options.chapterIds[0], 1), gate, options);
    return cached;
  }

  const seedUrl = options.seedUrl || DEFAULT_SEED_URL;
  console.log(`[教材] 按名称选择「${options.versionName} / ${options.textbookName}」，入口 ${seedUrl}`);
  await loadCatalogTree(page, seedUrl, gate, options);
  const versions = await readVersionsFromPage(page, seedUrl);
  const version = pickExactByName(versions, options.versionName, { nameKey: 'versionName', label: '版本' });
  const listed = await selectVersion(page, version, gate, options, null);
  const textbooks = normalizeTextbookRecords(listed, {
    versionExternalId: version.externalVersionId,
    baseUrl: options.baseUrl,
    bankPath: options.bankPath,
    seedUrl,
    allowEmpty: true,
  });
  const textbook = pickExactByName(textbooks, options.textbookName, { nameKey: 'textbookName', label: '教材' });
  if (!textbook.sourceUrl) {
    throw new StopCrawlError(`教材 ${textbook.textbookName} 缺少可访问地址。`, 'textbook_url_missing');
  }
  await loadCatalogTree(page, textbook.sourceUrl, gate, options);
  const tree = await readBootstrapChapter(page);
  if (!tree.bootstrapChapterExternalId) {
    throw new StopCrawlError(`教材 ${textbook.textbookName} 目录树缺少顶级章节 ID。`, 'tree_contract');
  }
  options.textbookId = String(textbook.externalTextbookId);
  options.chapterIds = [String(tree.bootstrapChapterExternalId)];
  try {
    const meta = new MetadataStore(options.dbPath);
    try {
      meta.saveVersionGroup({
        externalVersionId: version.externalVersionId,
        versionName: version.versionName,
        isNew: version.isNew,
        sortOrder: version.sortOrder,
        sourceUrl: seedUrl,
        raw: version.raw || version,
      }, [{
        ...textbook,
        bootstrapChapterExternalId: String(tree.bootstrapChapterExternalId),
        versionExternalId: version.externalVersionId,
      }], nowIso());
    } finally {
      meta.close();
    }
  } catch (error) {
    console.warn(`[提醒] 未能写入教材元数据：${error.message}`);
  }
  console.log(
    `[教材] ${version.versionName} / ${textbook.textbookName} → 入口章节 ${options.chapterIds[0]}`,
  );
  return {
    externalTextbookId: options.textbookId,
    bootstrapChapterExternalId: options.chapterIds[0],
    versionName: version.versionName,
    textbookName: textbook.textbookName,
  };
}

function resolveSyncScope(options, { dbPath } = {}) {
  if (options.chapterIds.length > 0) return options;
  if (options.namedTextbook) return options;
  if (options.textbookIdProvided) {
    const bootstrap = lookupBootstrapChapter(dbPath || options.dbPath, options.textbookId, {
      allowMissing: true,
    });
    options.chapterIds = [String(bootstrap || options.textbookId)];
    return options;
  }
  options.chapterIds = [DEFAULT_CHAPTER_ID];
  return options;
}

function buildFilterState(options) {
  return {
    scene: options.sceneId ? { id: options.sceneId, name: options.sceneName } : null,
    questionType: options.questionTypeId
      ? { id: options.questionTypeId, name: options.questionTypeName }
      : null,
    difficulty: options.difficultyId
      ? { id: options.difficultyId, name: options.difficultyName }
      : null,
    category: options.categoryId
      ? { id: options.categoryId, name: options.categoryName }
      : null,
    year: options.year,
    fresh: options.fresh,
    sort: { id: options.sortId, name: options.sortName },
  };
}

function buildListUrl(options, chapterId, pageNumber) {
  if (!/^\d+$/.test(String(chapterId))) throw new Error('chapterId 非法。');
  const tokens = buildFilterTokens(options, pageNumber);
  return new URL(`/${options.bankPath}/zj${chapterId}/${tokens.join('')}/`, options.baseUrl).href;
}

function buildCatalogListUrl(options, catalog) {
  return buildCatalogPageUrl(options, catalog, 1);
}

function buildCatalogPageUrl(options, catalog, pageNumber) {
  if (!catalog || !/^\d+$/.test(String(catalog.externalId))) throw new Error('catalog 非法。');
  const basePath = catalog.sourcePath
    || (Number(catalog.level) >= 3
      ? `/${options.bankPath}/zj${catalog.parentExternalId}/ctk${catalog.externalId}`
      : `/${options.bankPath}/zj${catalog.externalId}`);
  const filterPath = buildFilterTokens(options, pageNumber).join('');
  const normalizedBase = basePath.replace(/\/$/, '');
  const joined = Number(catalog.level) >= 3
    ? `${normalizedBase}${filterPath}`
    : `${normalizedBase}/${filterPath}/`;
  return new URL(joined, options.baseUrl).href;
}

function buildFilterTokens(options, pageNumber = 1) {
  const tokens = [];
  if (options.questionTypeId) tokens.push(`qt${options.questionTypeId}`);
  if (options.difficultyId) tokens.push(`d${options.difficultyId}`);
  if (options.year) tokens.push(`y${options.year}`);
  if (options.sceneId) tokens.push(`cjh${options.sceneId}`);
  if (options.categoryId) tokens.push(`fl${options.categoryId}`);
  if (options.fresh) tokens.push('x4');
  tokens.push(`o${options.sortId}`);
  if (pageNumber > 1) tokens.push(`p${pageNumber}`);
  return tokens;
}

function filterFacets(options) {
  const facets = [];
  if (options.sceneId) facets.push({ dimension: 'scene', value: options.sceneName || String(options.sceneId) });
  if (options.questionTypeId) {
    facets.push({ dimension: 'question_type', value: options.questionTypeName || String(options.questionTypeId) });
  }
  if (options.difficultyId) {
    facets.push({ dimension: 'difficulty', value: options.difficultyName || String(options.difficultyId) });
  }
  if (options.categoryId) {
    facets.push({ dimension: 'category', value: options.categoryName || String(options.categoryId) });
  }
  if (options.year) facets.push({ dimension: 'year', value: String(options.year) });
  if (options.fresh) facets.push({ dimension: 'fresh', value: '新题' });
  return facets;
}

function classifyAsset(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.includes('/formula/') || pathname.endsWith('.svg')) return 'formula';
  return 'image';
}

function parseListUsageMeta({ titles = [], referenceLabel = '', papers = [] } = {}) {
  const useTitle = (titles || []).find((value) => /次组卷/.test(String(value || '')));
  const useMatch = String(useTitle || '').match(/(\d+)次组卷/);
  const referenceMatch = String(referenceLabel || '').match(/(\d+)卷引用/);
  const referencePapers = (papers || [])
    .map((paper) => ({
      name: normalizeWhitespace(paper.name || paper.title || ''),
      url: paper.url || null,
    }))
    .filter((paper) => paper.name);
  const parsedReferenceCount = referenceMatch ? Number(referenceMatch[1]) : NaN;
  const referenceCount = Number.isFinite(parsedReferenceCount)
    ? parsedReferenceCount
    : (referencePapers.length > 0 ? referencePapers.length : null);
  const parsedUseCount = useMatch ? Number(useMatch[1]) : NaN;
  return {
    useCount: Number.isFinite(parsedUseCount) ? parsedUseCount : null,
    referenceCount,
    referencePapers,
  };
}

function applyListUsageMeta(question) {
  const parsed = parseListUsageMeta({
    titles: question.usageTitles || [],
    referenceLabel: question.referenceLabel || '',
    papers: question.referencePapers || [],
  });
  const next = {
    ...question,
    useCount: parsed.useCount,
    referenceCount: parsed.referenceCount,
    referencePapers: parsed.referencePapers,
  };
  delete next.usageTitles;
  delete next.referenceLabel;
  return next;
}

function parseDifficultyText(text) {
  const normalized = normalizeWhitespace(text);
  const coefficient = normalized.match(/\((\d+(?:\.\d+)?)\)/)?.[1];
  const label = normalized.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
  return {
    label,
    coefficient: coefficient == null ? null : Number(coefficient),
  };
}

function countSubquestions(text) {
  const matches = String(text || '').match(/(?:^|\s|\n)[（(]\d+[)）]/g);
  return matches ? matches.length : 0;
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

class SyncStore {
  constructor(dbPath, options = {}) {
    ensureDir(path.dirname(dbPath));
    this.dataDir = options?.dataDir ? path.resolve(options.dataDir) : null;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        pages_ok INTEGER NOT NULL DEFAULT 0,
        questions_seen INTEGER NOT NULL DEFAULT 0,
        questions_inserted INTEGER NOT NULL DEFAULT 0,
        questions_updated INTEGER NOT NULL DEFAULT 0,
        details_fetched INTEGER NOT NULL DEFAULT 0,
        assets_downloaded INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        message TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        scope_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        filter_json TEXT NOT NULL,
        last_completed_page INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS textbook_nodes (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        textbook_external_id TEXT,
        parent_external_id TEXT,
        node_level INTEGER,
        node_type TEXT,
        name TEXT NOT NULL,
        source_path TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (provider, external_id)
      );

      CREATE TABLE IF NOT EXISTS questions (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        bank_id INTEGER,
        chapter_id TEXT,
        detail_url TEXT,
        source_short TEXT,
        source_title TEXT,
        source_url TEXT,
        question_type TEXT,
        question_type_id TEXT,
        difficulty_label TEXT,
        difficulty_code TEXT,
        ease_coefficient REAL,
        content_html TEXT,
        plain_text TEXT,
        content_hash TEXT,
        list_content_hash TEXT,
        detail_content_hash TEXT,
        detail_fetched INTEGER NOT NULL DEFAULT 0,
        subquestion_count INTEGER NOT NULL DEFAULT 0,
        child_count INTEGER,
        has_image INTEGER NOT NULL DEFAULT 0,
        has_formula INTEGER NOT NULL DEFAULT 0,
        has_table INTEGER NOT NULL DEFAULT 0,
        is_new INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER,
        provider_updated_at TEXT,
        answer_html TEXT,
        analysis_html TEXT,
        answer_status TEXT NOT NULL DEFAULT 'not_collected',
        solution_html TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (provider, external_id)
      );

      CREATE TABLE IF NOT EXISTS question_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        question_external_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        UNIQUE (provider, question_external_id, content_hash)
      );

      CREATE TABLE IF NOT EXISTS question_knowledge (
        provider TEXT NOT NULL,
        question_external_id TEXT NOT NULL,
        knowledge_external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        knowledge_kind TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (provider, question_external_id, knowledge_external_id, knowledge_kind)
      );

      CREATE TABLE IF NOT EXISTS question_catalog_memberships (
        provider TEXT NOT NULL,
        question_external_id TEXT NOT NULL,
        catalog_external_id TEXT NOT NULL,
        catalog_level INTEGER,
        catalog_name TEXT,
        catalog_path TEXT,
        evidence_type TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (
          provider,
          question_external_id,
          catalog_external_id,
          evidence_type,
          query_fingerprint
        )
      );

      CREATE TABLE IF NOT EXISTS question_facets (
        provider TEXT NOT NULL,
        question_external_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        value TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (
          provider,
          question_external_id,
          dimension,
          value,
          evidence_type,
          query_fingerprint
        )
      );

      CREATE TABLE IF NOT EXISTS question_assets (
        provider TEXT NOT NULL,
        question_external_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        local_path TEXT,
        sha256 TEXT,
        mime_type TEXT,
        byte_size INTEGER,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (provider, question_external_id, source_url)
      );

      CREATE TABLE IF NOT EXISTS source_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        snapshot_type TEXT NOT NULL,
        source_url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        file_path TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES sync_runs(id)
      );

      CREATE TABLE IF NOT EXISTS sync_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        source_url TEXT,
        stage TEXT NOT NULL,
        error_code TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES sync_runs(id)
      );

      CREATE TABLE IF NOT EXISTS catalog_list_stats (
        scope_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        catalog_external_id TEXT NOT NULL,
        chapter_id TEXT,
        filter_json TEXT NOT NULL,
        expected_total INTEGER,
        page_capacity INTEGER,
        expected_pages INTEGER,
        list_seen_count INTEGER NOT NULL DEFAULT 0,
        last_completed_page INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_progress (
        run_id INTEGER NOT NULL,
        worker_id INTEGER NOT NULL,
        catalog_external_id TEXT,
        catalog_name TEXT,
        catalog_path TEXT,
        current_page INTEGER,
        expected_pages INTEGER,
        expected_total INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, worker_id)
      );
    `);

    migrateRunSnapshotSchema(this.db);

    const questionColumns = new Set(
      this.db.prepare('PRAGMA table_info(questions)').all().map((row) => row.name),
    );
    if (!questionColumns.has('list_content_hash')) {
      this.db.exec('ALTER TABLE questions ADD COLUMN list_content_hash TEXT');
    }
    if (!questionColumns.has('detail_content_hash')) {
      this.db.exec('ALTER TABLE questions ADD COLUMN detail_content_hash TEXT');
    }
    if (!questionColumns.has('detail_fetched')) {
      this.db.exec('ALTER TABLE questions ADD COLUMN detail_fetched INTEGER NOT NULL DEFAULT 0');
    }
    if (!questionColumns.has('answer_html')) {
      this.db.exec('ALTER TABLE questions ADD COLUMN answer_html TEXT');
    }
    if (!questionColumns.has('analysis_html')) {
      this.db.exec('ALTER TABLE questions ADD COLUMN analysis_html TEXT');
    }
    if (!questionColumns.has('answer_status')) {
      this.db.exec("ALTER TABLE questions ADD COLUMN answer_status TEXT NOT NULL DEFAULT 'not_collected'");
    }
    if (!questionColumns.has('solution_html')) {
      this.db.exec('ALTER TABLE questions ADD COLUMN solution_html TEXT');
    }
    this.db.exec(`
      UPDATE questions
      SET answer_status = 'not_collected'
      WHERE answer_status IS NULL OR answer_status = ''
    `);
  }

  prepare() {
    this.stmt = {
      insertRun: this.db.prepare(`
        INSERT INTO sync_runs (provider, started_at, status, scope_json)
        VALUES (?, ?, 'running', ?)
      `),
      finishRun: this.db.prepare(`
        UPDATE sync_runs
        SET finished_at = COALESCE(finished_at, ?), status = ?, pages_ok = ?, questions_seen = ?,
            questions_inserted = ?, questions_updated = ?, details_fetched = ?,
            assets_downloaded = ?, error_count = ?, message = ?,
            snapshot_locked_at = COALESCE(snapshot_locked_at, ?)
        WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
      `),
      getCheckpoint: this.db.prepare(`
        SELECT last_completed_page FROM sync_checkpoints WHERE scope_key = ?
      `),
      upsertCheckpoint: this.db.prepare(`
        INSERT INTO sync_checkpoints (
          scope_key, provider, chapter_id, filter_json, last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          last_completed_page = excluded.last_completed_page,
          updated_at = excluded.updated_at
      `),
      getRunCheckpoint: this.db.prepare(`
        SELECT last_completed_page
        FROM ${sqlIdentifier(RUN_CHECKPOINT_TABLE)}
        WHERE run_id = ? AND scope_key = ? AND provider = ?
      `),
      upsertRunCheckpoint: this.db.prepare(`
        INSERT INTO ${sqlIdentifier(RUN_CHECKPOINT_TABLE)} (
          run_id, scope_key, provider, chapter_id, filter_json,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, scope_key) DO UPDATE SET
          provider = excluded.provider,
          chapter_id = excluded.chapter_id,
          filter_json = excluded.filter_json,
          last_completed_page = MAX(
            ${sqlIdentifier(RUN_CHECKPOINT_TABLE)}.last_completed_page,
            excluded.last_completed_page
          ),
          updated_at = excluded.updated_at
      `),
      getQuestion: this.db.prepare(`
        SELECT external_id, content_hash, list_content_hash, detail_content_hash,
               detail_fetched, provider_updated_at, detail_url
        FROM questions WHERE provider = ? AND external_id = ?
      `),
      upsertNode: this.db.prepare(`
        INSERT INTO textbook_nodes (
          provider, external_id, textbook_external_id, parent_external_id,
          node_level, node_type, name, source_path, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, external_id) DO UPDATE SET
          textbook_external_id = excluded.textbook_external_id,
          parent_external_id = excluded.parent_external_id,
          node_level = excluded.node_level,
          node_type = excluded.node_type,
          name = excluded.name,
          source_path = excluded.source_path,
          last_seen_at = excluded.last_seen_at
      `),
      upsertQuestion: this.db.prepare(`
        INSERT INTO questions (
          provider, external_id, bank_id, chapter_id, detail_url,
          source_short, source_title, source_url,
          question_type, question_type_id, difficulty_label, difficulty_code,
          ease_coefficient, content_html, plain_text, content_hash,
          list_content_hash, detail_content_hash, detail_fetched,
          subquestion_count, child_count, has_image, has_formula, has_table,
          is_new, use_count, provider_updated_at,
          answer_html, analysis_html, answer_status, solution_html,
          first_seen_at, last_seen_at, raw_json
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?
        )
        ON CONFLICT(provider, external_id) DO UPDATE SET
          bank_id = COALESCE(excluded.bank_id, questions.bank_id),
          chapter_id = COALESCE(excluded.chapter_id, questions.chapter_id),
          detail_url = COALESCE(excluded.detail_url, questions.detail_url),
          source_short = COALESCE(excluded.source_short, questions.source_short),
          source_title = COALESCE(excluded.source_title, questions.source_title),
          source_url = COALESCE(excluded.source_url, questions.source_url),
          question_type = COALESCE(excluded.question_type, questions.question_type),
          question_type_id = COALESCE(excluded.question_type_id, questions.question_type_id),
          difficulty_label = COALESCE(excluded.difficulty_label, questions.difficulty_label),
          difficulty_code = COALESCE(excluded.difficulty_code, questions.difficulty_code),
          ease_coefficient = COALESCE(excluded.ease_coefficient, questions.ease_coefficient),
          content_html = CASE
            WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
              THEN COALESCE(excluded.content_html, questions.content_html)
            ELSE questions.content_html END,
          plain_text = CASE
            WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
              THEN COALESCE(excluded.plain_text, questions.plain_text)
            ELSE questions.plain_text END,
          content_hash = CASE
            WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
              THEN COALESCE(excluded.content_hash, questions.content_hash)
            ELSE questions.content_hash END,
          list_content_hash = COALESCE(excluded.list_content_hash, questions.list_content_hash),
          detail_content_hash = COALESCE(excluded.detail_content_hash, questions.detail_content_hash),
          detail_fetched = CASE WHEN excluded.detail_fetched = 1 THEN 1 ELSE questions.detail_fetched END,
          subquestion_count = CASE
            WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
              THEN excluded.subquestion_count
            ELSE questions.subquestion_count END,
          child_count = COALESCE(excluded.child_count, questions.child_count),
          has_image = CASE WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
            THEN excluded.has_image ELSE questions.has_image END,
          has_formula = CASE WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
            THEN excluded.has_formula ELSE questions.has_formula END,
          has_table = CASE WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
            THEN excluded.has_table ELSE questions.has_table END,
          is_new = excluded.is_new,
          use_count = COALESCE(excluded.use_count, questions.use_count),
          provider_updated_at = COALESCE(excluded.provider_updated_at, questions.provider_updated_at),
          answer_html = CASE
            WHEN excluded.answer_status IN ('not_visible', 'login_required') THEN NULL
            ELSE COALESCE(excluded.answer_html, questions.answer_html) END,
          analysis_html = CASE
            WHEN excluded.answer_status IN ('not_visible', 'login_required') THEN NULL
            ELSE COALESCE(excluded.analysis_html, questions.analysis_html) END,
          answer_status = CASE
            WHEN excluded.answer_status IN ('public_captured', 'not_visible', 'login_required')
              THEN excluded.answer_status
            WHEN questions.answer_status IS NULL OR questions.answer_status = ''
              THEN COALESCE(excluded.answer_status, 'not_collected')
            ELSE questions.answer_status END,
          solution_html = CASE
            WHEN excluded.answer_status IN ('not_visible', 'login_required') THEN NULL
            ELSE COALESCE(excluded.solution_html, questions.solution_html) END,
          last_seen_at = excluded.last_seen_at,
          raw_json = CASE WHEN excluded.detail_fetched = 1 OR questions.detail_fetched = 0
            THEN excluded.raw_json ELSE questions.raw_json END
      `),
      insertRevision: this.db.prepare(`
        INSERT OR IGNORE INTO question_revisions (
          provider, question_external_id, content_hash, captured_at, data_json
        ) VALUES (?, ?, ?, ?, ?)
      `),
      insertRunCatalogItem: this.db.prepare(`
        INSERT INTO sync_run_catalog_items (
          run_id, provider, textbook_external_id, catalog_external_id,
          parent_external_id, node_level, node_type, name, source_path,
          catalog_path, sort_order, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id) DO NOTHING
      `),
      upsertRunQuestionItem: this.db.prepare(`
        INSERT INTO sync_run_question_items (
          run_id, provider, textbook_external_id, question_external_id,
          chapter_id, detail_url, source_short, source_title, source_url,
          question_type, question_type_id, difficulty_label, difficulty_code,
          ease_coefficient, content_html, plain_text, content_hash,
          list_content_hash, detail_content_hash, content_version,
          question_version, snapshot_version, detail_fetched,
          subquestion_count, child_count, has_image, has_formula, has_table,
          is_new, use_count, provider_updated_at,
          answer_html, analysis_html, answer_status, solution_html, raw_json, captured_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          1, 1, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(run_id, provider, textbook_external_id, question_external_id) DO UPDATE SET
          chapter_id = COALESCE(excluded.chapter_id, sync_run_question_items.chapter_id),
          detail_url = COALESCE(excluded.detail_url, sync_run_question_items.detail_url),
          source_short = COALESCE(excluded.source_short, sync_run_question_items.source_short),
          source_title = COALESCE(excluded.source_title, sync_run_question_items.source_title),
          source_url = COALESCE(excluded.source_url, sync_run_question_items.source_url),
          question_type = COALESCE(excluded.question_type, sync_run_question_items.question_type),
          question_type_id = COALESCE(excluded.question_type_id, sync_run_question_items.question_type_id),
          difficulty_label = COALESCE(excluded.difficulty_label, sync_run_question_items.difficulty_label),
          difficulty_code = COALESCE(excluded.difficulty_code, sync_run_question_items.difficulty_code),
          ease_coefficient = COALESCE(excluded.ease_coefficient, sync_run_question_items.ease_coefficient),
          content_html = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN COALESCE(excluded.content_html, sync_run_question_items.content_html)
            ELSE sync_run_question_items.content_html END,
          plain_text = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN COALESCE(excluded.plain_text, sync_run_question_items.plain_text)
            ELSE sync_run_question_items.plain_text END,
          content_hash = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN COALESCE(excluded.content_hash, sync_run_question_items.content_hash)
            ELSE sync_run_question_items.content_hash END,
          list_content_hash = COALESCE(
            excluded.list_content_hash, sync_run_question_items.list_content_hash
          ),
          detail_content_hash = COALESCE(
            excluded.detail_content_hash, sync_run_question_items.detail_content_hash
          ),
          content_version = COALESCE(
            excluded.content_version, sync_run_question_items.content_version
          ),
          question_version = sync_run_question_items.question_version + CASE
            WHEN COALESCE(excluded.content_version, '') <>
                 COALESCE(sync_run_question_items.content_version, '') THEN 1
            ELSE 0 END,
          detail_fetched = CASE
            WHEN excluded.detail_fetched = 1 THEN 1
            ELSE sync_run_question_items.detail_fetched END,
          subquestion_count = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN excluded.subquestion_count
            ELSE sync_run_question_items.subquestion_count END,
          child_count = COALESCE(excluded.child_count, sync_run_question_items.child_count),
          has_image = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN excluded.has_image
            ELSE sync_run_question_items.has_image END,
          has_formula = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN excluded.has_formula
            ELSE sync_run_question_items.has_formula END,
          has_table = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN excluded.has_table
            ELSE sync_run_question_items.has_table END,
          is_new = excluded.is_new,
          use_count = COALESCE(excluded.use_count, sync_run_question_items.use_count),
          provider_updated_at = COALESCE(
            excluded.provider_updated_at, sync_run_question_items.provider_updated_at
          ),
          answer_html = CASE
            WHEN excluded.answer_status IN ('not_visible', 'login_required') THEN NULL
            ELSE COALESCE(
              excluded.answer_html, sync_run_question_items.answer_html
            ) END,
          analysis_html = CASE
            WHEN excluded.answer_status IN ('not_visible', 'login_required') THEN NULL
            ELSE COALESCE(
              excluded.analysis_html, sync_run_question_items.analysis_html
            ) END,
          answer_status = CASE
            WHEN excluded.answer_status IN ('public_captured', 'not_visible', 'login_required')
              THEN excluded.answer_status
            WHEN sync_run_question_items.answer_status IS NULL
              OR sync_run_question_items.answer_status = ''
              THEN COALESCE(excluded.answer_status, 'not_collected')
            ELSE sync_run_question_items.answer_status END,
          solution_html = CASE
            WHEN excluded.answer_status IN ('not_visible', 'login_required') THEN NULL
            ELSE COALESCE(excluded.solution_html, sync_run_question_items.solution_html) END,
          raw_json = CASE
            WHEN excluded.detail_fetched = 1 OR sync_run_question_items.detail_fetched = 0
              THEN excluded.raw_json
            ELSE sync_run_question_items.raw_json END,
          captured_at = excluded.captured_at
      `),
      insertRunQuestionCatalog: this.db.prepare(`
        INSERT INTO sync_run_question_catalogs (
          run_id, provider, textbook_external_id, question_external_id,
          catalog_external_id, catalog_level, catalog_name, catalog_path,
          evidence_type, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          run_id, provider, textbook_external_id,
          question_external_id, catalog_external_id
        ) DO NOTHING
      `),
      upsertRunQuestionTag: this.db.prepare(`
        INSERT INTO sync_run_question_tags (
          run_id, provider, textbook_external_id, question_external_id,
          dimension, tag_external_id, tag_value, relation_type,
          evidence_type, query_fingerprint, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          run_id, provider, textbook_external_id, question_external_id,
          dimension, tag_external_id, tag_value, relation_type,
          evidence_type, query_fingerprint
        ) DO UPDATE SET observed_at = excluded.observed_at
      `),
      upsertRunQuestionAsset: this.db.prepare(`
        INSERT INTO sync_run_question_assets (
          run_id, provider, textbook_external_id, question_external_id,
          asset_key, asset_type, source_url, content_sha256, storage_path,
          mime_type, byte_size, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          run_id, provider, textbook_external_id, question_external_id, asset_key
        ) DO UPDATE SET
          asset_type = excluded.asset_type,
          source_url = excluded.source_url,
          content_sha256 = COALESCE(excluded.content_sha256, sync_run_question_assets.content_sha256),
          storage_path = COALESCE(excluded.storage_path, sync_run_question_assets.storage_path),
          mime_type = COALESCE(excluded.mime_type, sync_run_question_assets.mime_type),
          byte_size = COALESCE(excluded.byte_size, sync_run_question_assets.byte_size),
          observed_at = excluded.observed_at
      `),
      upsertKnowledge: this.db.prepare(`
        INSERT INTO question_knowledge (
          provider, question_external_id, knowledge_external_id, name,
          knowledge_kind, evidence_type, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, question_external_id, knowledge_external_id, knowledge_kind)
        DO UPDATE SET
          name = excluded.name,
          evidence_type = excluded.evidence_type,
          observed_at = excluded.observed_at
      `),
      upsertCatalogMembership: this.db.prepare(`
        INSERT INTO question_catalog_memberships (
          provider, question_external_id, catalog_external_id,
          catalog_level, catalog_name, catalog_path,
          evidence_type, query_fingerprint, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          provider, question_external_id, catalog_external_id,
          evidence_type, query_fingerprint
        ) DO UPDATE SET
          catalog_level = excluded.catalog_level,
          catalog_name = excluded.catalog_name,
          catalog_path = excluded.catalog_path,
          observed_at = excluded.observed_at
      `),
      upsertFacet: this.db.prepare(`
        INSERT INTO question_facets (
          provider, question_external_id, dimension, value,
          evidence_type, query_fingerprint, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          provider, question_external_id, dimension, value,
          evidence_type, query_fingerprint
        ) DO UPDATE SET observed_at = excluded.observed_at
      `),
      upsertAsset: this.db.prepare(`
        INSERT INTO question_assets (
          provider, question_external_id, source_url, asset_type,
          local_path, sha256, mime_type, byte_size, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, question_external_id, source_url) DO UPDATE SET
          asset_type = excluded.asset_type,
          local_path = COALESCE(excluded.local_path, question_assets.local_path),
          sha256 = COALESCE(excluded.sha256, question_assets.sha256),
          mime_type = COALESCE(excluded.mime_type, question_assets.mime_type),
          byte_size = COALESCE(excluded.byte_size, question_assets.byte_size),
          observed_at = excluded.observed_at
      `),
      insertSnapshot: this.db.prepare(`
        INSERT INTO source_snapshots (
          run_id, snapshot_type, source_url, content_hash, file_path, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `),
      insertError: this.db.prepare(`
        INSERT INTO sync_errors (
          run_id, source_url, stage, error_code, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `),
      recentRuns: this.db.prepare(`
        SELECT id, started_at, finished_at, status, pages_ok, questions_seen,
               questions_inserted, questions_updated, details_fetched,
               assets_downloaded, error_count, message, snapshot_locked_at,
               snapshot_complete, catalog_item_count, question_item_count,
               question_catalog_count, question_tag_count, question_asset_count
        FROM sync_runs ORDER BY id DESC LIMIT 20
      `),
      getAssetByUrl: this.db.prepare(`
        SELECT local_path, sha256, mime_type, byte_size, asset_type
        FROM question_assets
        WHERE provider = ? AND source_url = ? AND local_path IS NOT NULL AND local_path != ''
        LIMIT 1
      `),
      listMissingAssetUrls: this.db.prepare(`
        SELECT source_url AS source_url, MIN(asset_type) AS asset_type
        FROM question_assets
        WHERE provider = ? AND (local_path IS NULL OR local_path = '')
        GROUP BY source_url
        LIMIT ?
      `),
      updateAssetFileByUrl: this.db.prepare(`
        UPDATE question_assets
        SET local_path = ?, sha256 = ?, mime_type = ?, byte_size = ?
        WHERE provider = ? AND source_url = ?
      `),
      upsertCatalogListStats: this.db.prepare(`
        INSERT INTO catalog_list_stats (
          scope_key, provider, catalog_external_id, chapter_id, filter_json,
          expected_total, page_capacity, expected_pages, list_seen_count,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          expected_total = COALESCE(excluded.expected_total, catalog_list_stats.expected_total),
          page_capacity = COALESCE(excluded.page_capacity, catalog_list_stats.page_capacity),
          expected_pages = COALESCE(excluded.expected_pages, catalog_list_stats.expected_pages),
          list_seen_count = catalog_list_stats.list_seen_count + excluded.list_seen_count,
          last_completed_page = MAX(catalog_list_stats.last_completed_page, excluded.last_completed_page),
          updated_at = excluded.updated_at
      `),
      upsertSyncProgress: this.db.prepare(`
        INSERT INTO sync_progress (
          run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
          current_page, expected_pages, expected_total, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, worker_id) DO UPDATE SET
          catalog_external_id = excluded.catalog_external_id,
          catalog_name = excluded.catalog_name,
          catalog_path = excluded.catalog_path,
          current_page = excluded.current_page,
          expected_pages = excluded.expected_pages,
          expected_total = excluded.expected_total,
          updated_at = excluded.updated_at
      `),
      listTextbookNodes: this.db.prepare(`
        SELECT external_id, textbook_external_id, parent_external_id, node_level, name, source_path
        FROM textbook_nodes WHERE provider = ?
      `),
      listMembershipPairs: this.db.prepare(`
        SELECT catalog_external_id, question_external_id
        FROM question_catalog_memberships WHERE provider = ?
      `),
      listCatalogStats: this.db.prepare(`
        SELECT catalog_external_id, expected_total, page_capacity, expected_pages,
               list_seen_count, last_completed_page, updated_at
        FROM catalog_list_stats WHERE provider = ?
        ORDER BY updated_at DESC
      `),
      listSyncProgress: this.db.prepare(`
        SELECT run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
               current_page, expected_pages, expected_total, updated_at
        FROM sync_progress
        ORDER BY updated_at DESC
      `),
      counts: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM questions) AS questions,
          (SELECT COUNT(*) FROM textbook_nodes) AS nodes,
          (SELECT COUNT(*) FROM question_catalog_memberships) AS catalog_links,
          (SELECT COUNT(*) FROM question_knowledge) AS knowledge_links,
          (SELECT COUNT(*) FROM question_facets) AS facets,
          (SELECT COUNT(*) FROM question_assets) AS assets
      `),
      runSnapshotCounts: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM sync_run_catalog_items WHERE run_id = ?) AS catalog_count,
          (SELECT COUNT(*) FROM sync_run_question_items WHERE run_id = ?) AS question_count,
          (SELECT COUNT(*) FROM sync_run_question_catalogs WHERE run_id = ?) AS question_catalog_count,
          (SELECT COUNT(*) FROM sync_run_question_tags WHERE run_id = ?) AS question_tag_count,
          (SELECT COUNT(*) FROM sync_run_question_assets WHERE run_id = ?) AS question_asset_count
      `),
    };
  }

  beginRun(scope, options = {}) {
    const requestedScope = scope && typeof scope === 'object' && !Array.isArray(scope)
      ? { ...scope }
      : {};
    const explicitResumeId = typeof options === 'object' && options !== null
      ? options.resumeFromRunId
      : options;
    const inheritedResumeId = requestedScope.resumeFromRunId ?? explicitResumeId;
    const parsedResumeId = inheritedResumeId == null || inheritedResumeId === ''
      ? null
      : Number(inheritedResumeId);
    if (parsedResumeId != null
      && (!Number.isSafeInteger(parsedResumeId) || parsedResumeId < 1)) {
      throw resumeSourceError('resumeFromRunId 必须是正整数');
    }
    if (parsedResumeId != null) requestedScope.resumeFromRunId = parsedResumeId;

    if (parsedResumeId == null) {
      const result = this.stmt.insertRun.run(PROVIDER, nowIso(), jsonValue(requestedScope));
      return Number(result.lastInsertRowid);
    }

    // Inserting the child run and copying all five source tables share one
    // transaction.  A rejected source therefore leaves no mutable orphan
    // run, while a committed child is already a valid running/unlocked copy.
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.stmt.insertRun.run(PROVIDER, nowIso(), jsonValue(requestedScope));
      const runId = Number(result.lastInsertRowid);
      const validated = validateResumeSourceRunInDb(this.db, parsedResumeId, requestedScope);
      const copied = copyResumeSnapshotRows(
        this.db,
        parsedResumeId,
        runId,
        validated.textbookExternalId,
      );
      const copiedTotal = Object.values(copied).reduce((sum, count) => sum + Number(count || 0), 0);
      if (copiedTotal < 1) {
        throw resumeSourceError(`来源运行 ${parsedResumeId} 没有可复制的教材快照`);
      }
      // Resume progress belongs to the immutable source run, not to the
      // mutable provider-wide checkpoint cache.  Clone it into the running
      // child in the same transaction as the five snapshot tables so the
      // child can never commit with rows but without its matching resume
      // boundary.  Legacy runs are reconstructed conservatively from their
      // own sync_progress rows by copyResumeRunCheckpoints.
      copyResumeRunCheckpoints(
        this.db,
        parsedResumeId,
        runId,
        validated.scope,
      );
      // Keep the running child header useful to orchestration/diagnostic
      // readers even before its first newly fetched page is committed.
      this.db.prepare(`
        UPDATE sync_runs
        SET catalog_item_count = ?, question_item_count = ?,
            question_catalog_count = ?, question_tag_count = ?,
            question_asset_count = ?
        WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
      `).run(
        validated.counts.catalogCount,
        validated.counts.questionCount,
        validated.counts.questionCatalogCount,
        validated.counts.questionTagCount,
        validated.counts.questionAssetCount,
        runId,
      );
      this.db.exec('COMMIT;');
      return runId;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  finishRun(runId, status, counters, message = null) {
    const terminalStatus = String(status || '').trim();
    if (!['success', 'completed', 'failed', 'blocked', 'interrupted', 'cancelled'].includes(terminalStatus)) {
      throw new Error(`无效的同步终态：${terminalStatus || '（空）'}`);
    }
    const parsedRunId = Number(runId);
    if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) return false;
    const finishedAt = nowIso();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const current = this.db.prepare(`
        SELECT id, status, snapshot_locked_at, scope_json
        FROM sync_runs WHERE id = ?
      `).get(parsedRunId);
      if (!current || String(current.status || '') !== 'running' || current.snapshot_locked_at) {
        this.db.exec('ROLLBACK;');
        return false;
      }

      const counts = this._readRunSnapshotCounts(parsedRunId);
      const readiness = this._snapshotReadiness(parsedRunId, counts, counters);
      const wantsSuccess = terminalStatus === 'success' || terminalStatus === 'completed';
      // A successful status is never allowed to escape the same transaction
      // as its completeness decision.  Incomplete runs are sealed as failed
      // (with a diagnostic message) so they remain immutable but unapplyable.
      const complete = wantsSuccess && readiness.complete;
      const effectiveStatus = complete ? terminalStatus : (wantsSuccess ? 'failed' : terminalStatus);
      const effectiveMessage = message == null || message === ''
        ? (complete ? null : readiness.reason)
        : String(message).slice(0, 4000);
      const result = this.db.prepare(`
        UPDATE sync_runs
        SET finished_at = COALESCE(finished_at, ?), status = ?,
            pages_ok = ?, questions_seen = ?, questions_inserted = ?,
            questions_updated = ?, details_fetched = ?, assets_downloaded = ?,
            error_count = ?, message = ?,
            catalog_item_count = ?, question_item_count = ?,
            question_catalog_count = ?, question_tag_count = ?,
            question_asset_count = ?, snapshot_complete = ?,
            snapshot_locked_at = COALESCE(snapshot_locked_at, ?)
        WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
      `).run(
        finishedAt,
        effectiveStatus,
        Number(counters?.pagesOk) || 0,
        Number(counters?.questionsSeen) || 0,
        Number(counters?.questionsInserted) || 0,
        Number(counters?.questionsUpdated) || 0,
        Number(counters?.detailsFetched) || 0,
        Number(counters?.assetsDownloaded) || 0,
        Number(counters?.errors) || 0,
        sqliteValue(effectiveMessage),
        counts.catalogCount,
        counts.questionCount,
        counts.questionCatalogCount,
        counts.questionTagCount,
        counts.questionAssetCount,
        complete ? 1 : 0,
        finishedAt,
        parsedRunId,
      );
      this.db.exec('COMMIT;');
      return Number(result?.changes || 0) > 0;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  _readRunSnapshotCounts(runId) {
    const row = this.stmt.runSnapshotCounts.get(
      Number(runId), Number(runId), Number(runId), Number(runId), Number(runId),
    );
    return {
      catalogCount: Number(row?.catalog_count || 0),
      questionCount: Number(row?.question_count || 0),
      questionCatalogCount: Number(row?.question_catalog_count || 0),
      questionTagCount: Number(row?.question_tag_count || 0),
      questionAssetCount: Number(row?.question_asset_count || 0),
    };
  }

  _snapshotReadiness(runId, counts, counters = {}) {
    const run = this.db.prepare(
      'SELECT scope_json, error_count FROM sync_runs WHERE id = ?',
    ).get(Number(runId));
    let scope = {};
    try {
      const parsed = JSON.parse(String(run?.scope_json || '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) scope = parsed;
    } catch {}
    const reasons = [];
    const flag = (value) => value === true || value === 1
      || ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
    if (counts.catalogCount <= 0) reasons.push('运行快照缺少目录');
    if (counts.questionCount <= 0) reasons.push('运行快照缺少题目');
    if (counts.questionCatalogCount <= 0) reasons.push('运行快照缺少题目目录关系');
    if (Number(counters?.errors || run?.error_count || 0) > 0) reasons.push('采集过程中出现错误');

    const expectedNumber = (...values) => {
      for (const value of values) {
        if (value == null || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
      }
      return null;
    };
    const expectedCatalogs = expectedNumber(
      scope.expectedCatalogCount,
      scope.expectedCatalogItemCount,
      scope.catalogItemCount,
      scope.catalogCount,
    );
    const expectedQuestions = expectedNumber(
      scope.expectedQuestionCount,
      scope.expectedQuestionItemCount,
      scope.questionItemCount,
      scope.questionCount,
    );
    const expectedRelations = expectedNumber(
      scope.expectedQuestionCatalogCount,
      scope.questionCatalogCount,
    );
    if (expectedCatalogs != null && counts.catalogCount < expectedCatalogs) reasons.push('目录范围未完整抓取');
    if (expectedQuestions != null && counts.questionCount < expectedQuestions) reasons.push('题目范围未完整抓取');
    if (expectedRelations != null && counts.questionCatalogCount < expectedRelations) reasons.push('题目目录关系范围未完整抓取');
    if (scope.scopeComplete === false || counters.scopeComplete === false) reasons.push('运行范围未完整抓取');
    if (scope.detailsComplete === false || counters.detailsComplete === false) reasons.push('题目详情未完整抓取');
    if (scope.assetsComplete === false || counters.assetsComplete === false) reasons.push('题目素材未完整下载');

    // A detail-enabled run is complete only when every captured question has
    // a successfully parsed detail page.  Undefined means legacy/direct CLI
    // mode and remains compatible with older callers.
    if (flag(scope.details) || flag(scope.requireDetails)) {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN COALESCE(detail_fetched, 0) = 1 THEN 1 ELSE 0 END) AS fetched
        FROM sync_run_question_items WHERE run_id = ?
      `).get(Number(runId));
      if (Number(row?.total || 0) > 0 && Number(row?.fetched || 0) !== Number(row.total || 0)) {
        reasons.push('题目详情未完整抓取');
      }
    }

    if (flag(scope.downloadAssets) || flag(scope.requireAssets)) {
      const missing = this.db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_assets
        WHERE run_id = ?
          AND (source_url IS NULL OR source_url = ''
            OR content_sha256 IS NULL OR content_sha256 = ''
            OR storage_path IS NULL OR storage_path = '')
      `).get(Number(runId));
      if (Number(missing?.n || 0) > 0) reasons.push('题目素材未完整下载');
      // Flags on a question are provider evidence that an asset should have
      // been captured.  Treat an absent row as incomplete when downloads are
      // mandatory, while allowing genuinely asset-free questions.
      const flagged = this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM sync_run_question_items AS q
        WHERE q.run_id = ? AND (COALESCE(q.has_image, 0) = 1 OR COALESCE(q.has_formula, 0) = 1)
          AND NOT EXISTS (
            SELECT 1 FROM sync_run_question_assets AS a
            WHERE a.run_id = q.run_id
              AND a.provider = q.provider
              AND a.textbook_external_id = q.textbook_external_id
              AND a.question_external_id = q.question_external_id
          )
      `).get(Number(runId));
      if (Number(flagged?.n || 0) > 0) reasons.push('题目标记的素材未写入快照');
    }

    // `--limit` and an explicit max-page cap are intentional truncation
    // signals.  A run can still be useful for diagnostics, but it is not an
    // applyable full snapshot.
    if (Number(scope.limit || 0) > 0) reasons.push('运行使用了题目数量上限');
    if (flag(scope.truncated) || flag(scope.incomplete) || scope.snapshotComplete === false
      || flag(counters?.truncated)) {
      reasons.push('运行范围未完整抓取');
    }
    // Per-run progress rows are authoritative when present.  Do not consult
    // global mutable catalog stats here: those belong to other runs.
    const progress = this.db.prepare(`
      SELECT catalog_external_id,
             MAX(COALESCE(current_page, 0)) AS current_page,
             MAX(COALESCE(expected_pages, 0)) AS expected_pages
      FROM sync_progress WHERE run_id = ?
      GROUP BY catalog_external_id
    `).all(Number(runId));
    for (const row of progress) {
      const expected = Number(row.expected_pages || 0);
      const current = Number(row.current_page || 0);
      if (expected > 0 && current < expected) {
        reasons.push('目录分页未完整抓取');
        break;
      }
    }
    return { complete: reasons.length === 0, reason: reasons.join('；') || null };
  }

  snapshotReadiness(runId, counters = {}) {
    return this._snapshotReadiness(runId, this._readRunSnapshotCounts(runId), counters);
  }

  getRun(runId) {
    const id = Number(runId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return this.db.prepare(`
      SELECT id, provider, started_at, finished_at, status, scope_json,
             pages_ok, questions_seen, questions_inserted, questions_updated,
             details_fetched, assets_downloaded, error_count, message,
             snapshot_locked_at, snapshot_complete,
             catalog_item_count, question_item_count, question_catalog_count,
             question_tag_count, question_asset_count
      FROM sync_runs WHERE id = ?
    `).get(id) || null;
  }

  saveRunCatalogTree(runId, textbookExternalId, nodes, observedAt = nowIso()) {
    const textbookId = String(textbookExternalId || '').trim();
    if (!textbookId) throw new Error('运行快照缺少教材来源 ID');
    for (const node of nodes || []) {
      const externalId = String(node?.externalId || '').trim();
      const name = String(node?.name || '').trim();
      if (!externalId || !name) continue;
      this.stmt.insertRunCatalogItem.run(
        Number(runId),
        PROVIDER,
        textbookId,
        externalId,
        node?.parentExternalId ? String(node.parentExternalId) : null,
        sqliteValue(node?.level),
        sqliteValue(node?.type),
        name,
        sqliteValue(node?.sourcePath),
        sqliteValue(node?.path || name),
        sqliteValue(node?.sortOrder),
        sqliteValue(observedAt, nowIso()),
      );
    }
  }

  saveRunQuestion(runId, textbookExternalId, question, chapterId, observedAt = nowIso()) {
    const item = question && typeof question === 'object' ? question : {};
    const externalId = String(item.externalId || '').trim();
    if (!externalId) throw new Error('运行快照题目缺少来源 ID');
    const rawJson = jsonValue(item);
    const hasExplicitAnswerStatus = item.answerStatus != null
      && String(item.answerStatus).trim() !== '';
    const explicitStatus = normalizeAnswerStatus(item.answerStatus, '');
    const hasSeparatedSolution = hasPublicSolutionField(item.answerHtml)
      || hasPublicSolutionField(item.analysisHtml);
    // A login marker is authoritative even if a stale/legacy caller supplies
    // a contradictory public status or HTML payload.  Never let that caller
    // turn a login-gated page into publishable answer content.
    const answerStatus = item.loginRequired
      ? 'login_required'
      : (explicitStatus || (hasSeparatedSolution ? 'public_captured' : 'not_collected'));
    const publicSolution = answerStatus === 'public_captured';
    const contentVersion = item.detailContentHash
      || item.contentHash
      || item.listContentHash
      || null;
    this.stmt.upsertRunQuestionItem.run(
      Number(runId),
      PROVIDER,
      String(textbookExternalId),
      externalId,
      chapterId ? String(chapterId) : null,
      sqliteValue(item.detailUrl),
      sqliteValue(item.sourceShort),
      sqliteValue(item.sourceTitle),
      sqliteValue(item.sourceUrl),
      sqliteValue(item.questionType),
      sqliteValue(item.questionTypeId),
      sqliteValue(item.difficultyLabel),
      sqliteValue(item.difficultyCode),
      sqliteValue(item.easeCoefficient),
      sqliteValue(item.contentHtml),
      sqliteValue(item.plainText),
      sqliteValue(item.contentHash),
      sqliteValue(item.listContentHash),
      sqliteValue(item.detailContentHash),
      sqliteValue(contentVersion),
      item.detailFetched ? 1 : 0,
      Number(item.subquestionCount) || 0,
      sqliteValue(item.childCount),
      item.hasImage ? 1 : 0,
      item.hasFormula ? 1 : 0,
      item.hasTable ? 1 : 0,
      item.isNew ? 1 : 0,
      sqliteValue(item.useCount),
      sqliteValue(item.providerUpdatedAt),
      publicSolution ? sqliteValue(item.answerHtml) : null,
      publicSolution ? sqliteValue(item.analysisHtml) : null,
      answerStatus,
      answerStatus === 'public_captured'
        || (answerStatus === 'not_collected' && !hasExplicitAnswerStatus)
        ? sqliteValue(item.solutionHtml) : null,
      rawJson,
      sqliteValue(observedAt, nowIso()),
    );
    // Capture all provider evidence in the run itself.  These writes are
    // intentionally independent of the mutable global facet/asset indexes.
    const snapshotTags = [
      ...(Array.isArray(item.providerLabels) ? item.providerLabels.map((tag) => ({
        ...tag,
        relationType: tag.relationType || 'provider_label',
        evidenceType: tag.evidenceType || 'provider_asserted',
        queryFingerprint: tag.queryFingerprint || 'provider',
      })) : []),
      ...(Array.isArray(item.knowledge) ? item.knowledge.map((tag) => ({
        ...tag,
        dimension: tag.dimension || tag.kind || 'knowledge',
        tagExternalId: tag.tagExternalId || tag.externalId,
        tagValue: tag.tagValue || tag.name,
        relationType: tag.relationType || 'knowledge',
        evidenceType: tag.evidenceType || 'provider_asserted',
        queryFingerprint: tag.queryFingerprint || 'provider',
      })) : []),
    ];
    this.saveRunQuestionTags(
      runId,
      textbookExternalId,
      externalId,
      snapshotTags,
      observedAt,
    );
    this.saveRunQuestionAssets(runId, textbookExternalId, externalId, item.assets, observedAt);
  }

  saveRunQuestionCatalogs(
    runId,
    textbookExternalId,
    questionExternalId,
    memberships,
    observedAt = nowIso(),
  ) {
    for (const membership of memberships || []) {
      const catalogId = String(membership?.externalId || '').trim();
      if (!catalogId) continue;
      this.stmt.insertRunQuestionCatalog.run(
        Number(runId),
        PROVIDER,
        String(textbookExternalId),
        String(questionExternalId),
        catalogId,
        sqliteValue(membership?.level),
        sqliteValue(membership?.name),
        sqliteValue(membership?.path || membership?.name),
        'query_membership',
        sqliteValue(observedAt, nowIso()),
      );
    }
  }

  /** Persist provider/facet/knowledge evidence in this run's immutable tag snapshot. */
  saveRunQuestionTags(
    runId,
    textbookExternalId,
    questionExternalId,
    tags,
    observedAt = nowIso(),
    defaultQueryFingerprint = 'provider',
  ) {
    const textbookId = String(textbookExternalId || '').trim();
    const questionId = String(questionExternalId || '').trim();
    if (!textbookId || !questionId) return 0;
    let count = 0;
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (!tag || typeof tag !== 'object') continue;
      const dimension = String(
        tag.dimension ?? tag.tagType ?? tag.tag_type ?? tag.kind ?? '',
      ).trim();
      const value = String(
        tag.tagValue ?? tag.tag_value ?? tag.value ?? tag.tagName ?? tag.tag_name ?? tag.name ?? '',
      ).trim();
      if (!dimension || !value) continue;
      const externalId = String(
        tag.tagExternalId ?? tag.tag_external_id ?? tag.externalId ?? tag.external_id ?? '',
      ).trim();
      const relationType = String(
        tag.relationType ?? tag.relation_type ?? 'tag',
      ).trim() || 'tag';
      const evidenceType = String(
        tag.evidenceType ?? tag.evidence_type ?? 'provider_asserted',
      ).trim() || 'provider_asserted';
      const fingerprint = String(
        tag.queryFingerprint ?? tag.query_fingerprint ?? defaultQueryFingerprint ?? 'provider',
      ).trim() || 'provider';
      this.stmt.upsertRunQuestionTag.run(
        Number(runId), PROVIDER, textbookId, questionId,
        dimension.slice(0, 120), externalId.slice(0, 200), value.slice(0, 4000),
        relationType.slice(0, 120), evidenceType.slice(0, 120), fingerprint.slice(0, 4000),
        sqliteValue(tag.observedAt ?? tag.observed_at ?? observedAt, nowIso()),
      );
      count += 1;
    }
    return count;
  }

  /** Persist one run's assets with an order-independent deterministic key. */
  saveRunQuestionAssets(
    runId,
    textbookExternalId,
    questionExternalId,
    assets,
    observedAt = nowIso(),
  ) {
    const textbookId = String(textbookExternalId || '').trim();
    const questionId = String(questionExternalId || '').trim();
    if (!textbookId || !questionId) return 0;
    let count = 0;
    const seen = new Set();
    for (const asset of Array.isArray(assets) ? assets : []) {
      if (!asset || typeof asset !== 'object') continue;
      const sourceUrl = String(asset.sourceUrl ?? asset.source_url ?? asset.url ?? '').trim();
      if (!sourceUrl) continue;
      const assetType = String(asset.assetType ?? asset.asset_type ?? asset.type ?? 'image').trim() || 'image';
      const suppliedKey = String(asset.assetKey ?? asset.asset_key ?? asset.key ?? '').trim();
      const assetKey = (suppliedKey || `${assetType}-${sha256(sourceUrl).slice(0, 16)}`).slice(0, 100);
      if (!assetKey || seen.has(assetKey)) continue;
      seen.add(assetKey);
      const contentHash = asset.contentSha256 ?? asset.content_sha256
        ?? asset.sha256 ?? asset.fileHash ?? asset.file_hash;
      let storagePath = asset.storagePath ?? asset.storage_path
        ?? asset.localPath ?? asset.local_path;
      // Never publish a machine-specific absolute path when the collector
      // knows its asset root.  The package/apply contract uses `assets/...`
      // relative paths; retain an unknown path only for legacy direct-store
      // callers that did not provide a data directory.
      if (storagePath && this.dataDir && path.isAbsolute(String(storagePath))) {
        const relative = path.relative(this.dataDir, String(storagePath)).split(path.sep).join('/');
        storagePath = relative && relative !== '..' && !relative.startsWith('../')
          ? relative
          : null;
      }
      this.stmt.upsertRunQuestionAsset.run(
        Number(runId), PROVIDER, textbookId, questionId, assetKey,
        assetType.slice(0, 80), sourceUrl.slice(0, 10000),
        sqliteValue(contentHash), sqliteValue(storagePath),
        sqliteValue(asset.mimeType ?? asset.mime_type),
        sqliteValue(asset.byteSize ?? asset.byte_size),
        sqliteValue(asset.observedAt ?? asset.observed_at ?? observedAt, nowIso()),
      );
      count += 1;
    }
    return count;
  }

  // Singular aliases make the store convenient for incremental collectors
  // and preserve compatibility with early prototype callers.
  saveRunQuestionTag(runId, textbookExternalId, questionExternalId, tag, observedAt = nowIso(), queryFingerprint = 'provider') {
    return this.saveRunQuestionTags(
      runId,
      textbookExternalId,
      questionExternalId,
      [tag],
      observedAt,
      queryFingerprint,
    );
  }

  saveRunQuestionAsset(runId, textbookExternalId, questionExternalId, asset, observedAt = nowIso()) {
    return this.saveRunQuestionAssets(
      runId,
      textbookExternalId,
      questionExternalId,
      [asset],
      observedAt,
    );
  }

  runSnapshotCounts(runId) {
    return this._readRunSnapshotCounts(runId);
  }

  getCheckpoint(scopeKey) {
    return this.stmt.getCheckpoint.get(scopeKey)?.last_completed_page || 0;
  }

  getRunCheckpoint(runId, scopeKey) {
    const parsedRunId = Number(runId);
    if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) return 0;
    const normalizedScopeKey = String(scopeKey || '').trim();
    if (!normalizedScopeKey) return 0;
    return normalizeCheckpointPage(
      this.stmt.getRunCheckpoint.get(parsedRunId, normalizedScopeKey, PROVIDER)
        ?.last_completed_page,
      0,
    );
  }

  // Alias retained for callers that prefer the conventional ForRun naming.
  getCheckpointForRun(runId, scopeKey) {
    return this.getRunCheckpoint(runId, scopeKey);
  }

  getQuestion(id) {
    return this.stmt.getQuestion.get(PROVIDER, String(id)) || null;
  }

  getAssetByUrl(url) {
    return this.stmt.getAssetByUrl.get(PROVIDER, String(url)) || null;
  }

  listMissingAssetUrls(limit = 40) {
    return this.stmt.listMissingAssetUrls.all(PROVIDER, Number(limit) || 40);
  }

  updateAssetFileByUrl(url, file) {
    this.stmt.updateAssetFileByUrl.run(
      file.localPath || null,
      file.sha256 || null,
      file.mimeType || null,
      file.byteSize ?? null,
      PROVIDER,
      String(url),
    );
  }

  saveCatalogListStats({
    scopeKey,
    catalogId,
    chapterId,
    filterJson,
    expectedTotal = null,
    pageCapacity = null,
    expectedPages = null,
    listSeenIncrement = 0,
    lastCompletedPage = 0,
    observedAt = nowIso(),
  }) {
    this.stmt.upsertCatalogListStats.run(
      scopeKey,
      PROVIDER,
      String(catalogId),
      chapterId ? String(chapterId) : null,
      filterJson || '{}',
      expectedTotal,
      pageCapacity,
      expectedPages,
      Number(listSeenIncrement) || 0,
      Number(lastCompletedPage) || 0,
      observedAt,
    );
  }

  saveSyncProgress({
    runId,
    workerId,
    catalog,
    currentPage = null,
    expectedPages = null,
    expectedTotal = null,
    observedAt = nowIso(),
  }) {
    this.stmt.upsertSyncProgress.run(
      Number(runId),
      Math.max(1, Number(workerId) || 1),
      catalog?.externalId ? String(catalog.externalId) : null,
      catalog?.name || null,
      catalog?.path || catalog?.name || null,
      currentPage,
      expectedPages,
      expectedTotal,
      observedAt,
    );
  }

  loadCatalogProgress() {
    const nodes = this.stmt.listTextbookNodes.all(PROVIDER).map((row) => ({
      externalId: String(row.external_id),
      textbookExternalId: row.textbook_external_id,
      parentExternalId: row.parent_external_id,
      level: row.node_level,
      name: row.name,
      sourcePath: row.source_path,
    }));
    const memberships = this.stmt.listMembershipPairs.all(PROVIDER).map((row) => ({
      catalogExternalId: String(row.catalog_external_id),
      questionExternalId: String(row.question_external_id),
    }));
    const stats = {};
    for (const row of this.stmt.listCatalogStats.all(PROVIDER)) {
      const id = String(row.catalog_external_id);
      if (stats[id]) continue;
      stats[id] = {
        expectedTotal: row.expected_total,
        pageCapacity: row.page_capacity,
        expectedPages: row.expected_pages,
        listSeenCount: row.list_seen_count,
        lastCompletedPage: row.last_completed_page,
      };
    }
    const currentByCatalog = {};
    for (const row of this.stmt.listSyncProgress.all()) {
      if (!row.catalog_external_id) continue;
      const id = String(row.catalog_external_id);
      if (currentByCatalog[id]) continue;
      currentByCatalog[id] = {
        runId: row.run_id,
        workerId: row.worker_id,
        currentPage: row.current_page,
        catalogName: row.catalog_name,
        catalogPath: row.catalog_path,
      };
    }
    return buildCatalogProgressTree({ nodes, memberships, stats, currentByCatalog });
  }

  savePageTransaction({
    runId,
    textbookExternalId,
    scopeKey,
    chapterId,
    filterJson,
    pageNumber,
    nodes,
    questions,
    facets,
    catalog,
  }) {
    const nodeRows = Array.isArray(nodes) ? nodes : [];
    const questionRows = Array.isArray(questions) ? questions : [];
    const facetRows = Array.isArray(facets) ? facets : [];
    const normalizedScopeKey = String(scopeKey || '').trim();
    if (!normalizedScopeKey) throw new Error('页面快照缺少 scopeKey');
    const normalizedChapterId = String(chapterId || '').trim();
    if (!normalizedChapterId) throw new Error('页面快照缺少 chapterId');
    const normalizedFilterJson = typeof filterJson === 'string'
      ? filterJson
      : jsonValue(filterJson || {});
    const observedAt = nowIso();
    let inserted = 0;
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const node of nodeRows) {
        const externalId = String(node?.externalId || '').trim();
        const nodeName = String(node?.name || '').trim();
        if (!externalId || !nodeName) continue;
        this.stmt.upsertNode.run(
          PROVIDER,
          externalId,
          node?.textbookExternalId ? String(node.textbookExternalId) : null,
          node?.parentExternalId ? String(node.parentExternalId) : null,
          sqliteValue(node?.level),
          sqliteValue(node?.type),
          nodeName,
          sqliteValue(node?.sourcePath),
          observedAt,
          observedAt,
        );
      }

      this.saveRunCatalogTree(runId, textbookExternalId, nodes, observedAt);

      for (const question of questionRows) {
        const questionId = String(question?.externalId || '').trim();
        if (!questionId) continue;
        const before = this.getQuestion(questionId);
        this.saveQuestion(question, chapterId, observedAt, before);
        this.saveRunQuestion(runId, textbookExternalId, question, chapterId, observedAt);
        if (!before) inserted += 1;
        else if (
          before.list_content_hash !== question.listContentHash
          || (question.detailFetched && before.detail_content_hash !== question.detailContentHash)
        ) updated += 1;

        for (const facet of facetRows) {
          if (!facet?.dimension || facet?.value == null || facet.value === '') continue;
          const facetValue = String(facet.value);
          this.stmt.upsertFacet.run(
            PROVIDER,
            questionId,
            String(facet.dimension),
            facetValue,
            'query_membership',
            normalizedScopeKey,
            observedAt,
          );
          this.saveRunQuestionTags(
            runId,
            textbookExternalId,
            questionId,
            [{
              dimension: facet.dimension,
              tagValue: facetValue,
              relationType: facet.relationType || 'facet',
              evidenceType: facet.evidenceType || 'query_membership',
              queryFingerprint: normalizedScopeKey,
            }],
            observedAt,
            normalizedScopeKey,
          );
        }

        if (catalog) {
          const nodeById = new Map(
            nodeRows
              .filter((node) => node?.externalId)
              .map((node) => [String(node.externalId), node]),
          );
          const memberships = [];
          const visited = new Set();
          let current = catalog;
          while (current && !visited.has(String(current.externalId))) {
            visited.add(String(current.externalId));
            memberships.push(current);
            current = current.parentExternalId
              ? nodeById.get(String(current.parentExternalId))
              : null;
          }
          for (const membership of memberships) {
            if (!membership?.externalId) continue;
            this.stmt.upsertCatalogMembership.run(
              PROVIDER,
              questionId,
              String(membership.externalId),
              sqliteValue(membership.level),
              sqliteValue(membership.name),
              sqliteValue(membership.path || membership.name),
              'query_membership',
              normalizedScopeKey,
              observedAt,
            );
          }
          this.saveRunQuestionCatalogs(
            runId,
            textbookExternalId,
              questionId,
            memberships,
            observedAt,
          );
        }
      }

      const checkpointPage = normalizeCheckpointPage(pageNumber, 0);
      this.stmt.upsertCheckpoint.run(
        normalizedScopeKey,
        PROVIDER,
        normalizedChapterId,
        normalizedFilterJson,
        checkpointPage,
        observedAt,
      );
      this.stmt.upsertRunCheckpoint.run(
        Number(runId),
        normalizedScopeKey,
        PROVIDER,
        normalizedChapterId,
        normalizedFilterJson,
        checkpointPage,
        observedAt,
      );
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return { inserted, updated };
  }

  saveQuestion(question, chapterId, observedAt = nowIso(), before = null) {
    const item = question && typeof question === 'object' ? question : {};
    const externalId = String(item.externalId || '').trim();
    if (!externalId) throw new Error('题目缺少来源 ID');
    const rawJson = jsonValue(item);
    const hasExplicitAnswerStatus = item.answerStatus != null
      && String(item.answerStatus).trim() !== '';
    const explicitStatus = normalizeAnswerStatus(item.answerStatus, '');
    const hasSeparatedSolution = hasPublicSolutionField(item.answerHtml)
      || hasPublicSolutionField(item.analysisHtml);
    // A login marker is authoritative even if a stale/legacy caller supplies
    // a contradictory public status or HTML payload.  Never let that caller
    // turn a login-gated page into publishable answer content.
    const answerStatus = item.loginRequired
      ? 'login_required'
      : (explicitStatus || (hasSeparatedSolution ? 'public_captured' : 'not_collected'));
    const publicSolution = answerStatus === 'public_captured';
    this.stmt.upsertQuestion.run(
      PROVIDER,
      externalId,
      sqliteValue(item.bankId),
      chapterId ? String(chapterId) : null,
      sqliteValue(item.detailUrl),
      sqliteValue(item.sourceShort),
      sqliteValue(item.sourceTitle),
      sqliteValue(item.sourceUrl),
      sqliteValue(item.questionType),
      sqliteValue(item.questionTypeId),
      sqliteValue(item.difficultyLabel),
      sqliteValue(item.difficultyCode),
      sqliteValue(item.easeCoefficient),
      sqliteValue(item.contentHtml),
      sqliteValue(item.plainText),
      sqliteValue(item.contentHash),
      sqliteValue(item.listContentHash),
      sqliteValue(item.detailContentHash),
      item.detailFetched ? 1 : 0,
      Number(item.subquestionCount) || 0,
      sqliteValue(item.childCount),
      item.hasImage ? 1 : 0,
      item.hasFormula ? 1 : 0,
      item.hasTable ? 1 : 0,
      item.isNew ? 1 : 0,
      sqliteValue(item.useCount),
      sqliteValue(item.providerUpdatedAt),
      publicSolution ? sqliteValue(item.answerHtml) : null,
      publicSolution ? sqliteValue(item.analysisHtml) : null,
      answerStatus,
      answerStatus === 'public_captured'
        || (answerStatus === 'not_collected' && !hasExplicitAnswerStatus)
        ? sqliteValue(item.solutionHtml) : null,
      sqliteValue(observedAt, nowIso()),
      sqliteValue(observedAt, nowIso()),
      rawJson,
    );

    const revisionHash = item.detailFetched
      ? (item.detailContentHash || item.contentHash)
      : (before?.detail_fetched ? null : item.contentHash);
    if (revisionHash) {
      this.stmt.insertRevision.run(
        PROVIDER,
        externalId,
        revisionHash,
        sqliteValue(observedAt, nowIso()),
        rawJson,
      );
    }

    for (const knowledge of item.knowledge || []) {
      if (!knowledge?.externalId || !knowledge?.name) continue;
      this.stmt.upsertKnowledge.run(
        PROVIDER,
        externalId,
        String(knowledge.externalId),
        String(knowledge.name),
        String(knowledge.kind || 'knowledge_point'),
        knowledge.evidenceType || 'provider_asserted',
        sqliteValue(observedAt, nowIso()),
      );
    }

    for (const label of item.providerLabels || []) {
      if (!label?.dimension || label?.value == null || label.value === '') continue;
      this.stmt.upsertFacet.run(
        PROVIDER,
        externalId,
        String(label.dimension),
        String(label.value),
        'provider_asserted',
        'provider',
        sqliteValue(observedAt, nowIso()),
      );
    }

    for (const asset of item.assets || []) {
      if (!asset?.url) continue;
      this.stmt.upsertAsset.run(
        PROVIDER,
        externalId,
        String(asset.url),
        String(asset.type || 'image'),
        sqliteValue(asset.localPath),
        sqliteValue(asset.sha256),
        sqliteValue(asset.mimeType),
        sqliteValue(asset.byteSize),
        sqliteValue(observedAt, nowIso()),
      );
    }
  }

  saveSnapshot(runId, snapshotType, sourceUrl, contentHash, filePath) {
    this.stmt.insertSnapshot.run(
      runId,
      snapshotType,
      sourceUrl,
      contentHash,
      filePath,
      nowIso(),
    );
  }

  recordError(runId, url, stage, error) {
    this.stmt.insertError.run(
      runId,
      url || null,
      stage,
      error.code || error.name || 'error',
      String(error.message || error),
      nowIso(),
    );
  }

  status() {
    return {
      counts: this.stmt.counts.get(),
      recentRuns: this.stmt.recentRuns.all(),
    };
  }

  close() {
    this.db.close();
  }
}

function assertAllowedUrl(rawUrl, allowedHosts) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    throw new StopCrawlError(`拒绝访问未授权域名：${parsed.href}`, 'host_not_allowed');
  }
  return parsed.href;
}

async function detectBlockedPage(page, contentSelector = SOURCE_CONTENT_SELECTOR) {
  const snapshot = await page.evaluate(({ selector, sliderMarkers }) => {
    const text = document.body?.innerText || '';
    const title = document.title || '';
    const combined = `${title} ${text}`.toLowerCase();
    return {
      hasChallengeInputs: Boolean(document.querySelector('#parm_0, #parm_1')),
      hasContent: Boolean(document.querySelector(selector)),
      slider: sliderMarkers.some((item) => combined.includes(item.toLowerCase())),
      text,
      title,
      preview: text.slice(0, 240),
    };
  }, { selector: contentSelector, sliderMarkers: SLIDER_TEXT_MARKERS });
  const classified = classifyProtectionState(snapshot);
  const state = {
    ...snapshot,
    ...classified,
    hasQuestionContent: snapshot.hasContent,
  };
  // Provider content is authoritative.  Question stems may legitimately
  // contain words such as "安全威胁" or "验证码"; those words alone
  // must never turn a successfully rendered list/detail page into a block.
  if (state.hasContent) return state;
  if (state.slider) {
    return { ...state, slider: true };
  }
  if (state.terminalBlock || state.transientChallenge) {
    throw new StopCrawlError(
      `站点返回验证/防护页面，任务已熔断。${state.marker ? ` 标记：${state.marker}` : ''}`,
      'challenge',
    );
  }
  return state;
}

async function waitForHumanSliderIfNeeded(page, _options, readySelector = SOURCE_CONTENT_SELECTOR) {
  const state = await detectBlockedPage(page, readySelector);
  if (!state.slider || state.hasQuestionContent) return state;
  throw new StopCrawlError(
    '站点返回滑块验证，已停止。不会自动拖滑块。请稍后用同一采集档案续跑，并适当加大 --delay-min/--delay-max。',
    'challenge',
  );
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
      await settleSourcePage(page, options, {
        label,
        contentSelector: SOURCE_CONTENT_SELECTOR,
      });
      await waitForHumanSliderIfNeeded(
        page,
        options,
        SOURCE_CONTENT_SELECTOR,
      );
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

async function extractTree(page) {
  return page.$$eval('.tk-tree li.tree-node', (items) => items.map((item) => {
    const own = item.querySelector(':scope > .tree-node-name[data-tree-id]');
    const anchor = own?.querySelector('a.tree-anchor');
    const parent = item.parentElement?.closest('li.tree-node');
    const level = Number(item.getAttribute('data-level') || 0);
    const labels = [];
    let current = item;
    while (current) {
      const label = current.querySelector(':scope > .tree-node-name > a.tree-anchor');
      if (label) labels.unshift((label.textContent || '').trim());
      current = current.parentElement?.closest('li.tree-node') || null;
    }
    return {
      externalId: item.getAttribute('tree-id') || own?.getAttribute('data-tree-id'),
      textbookExternalId: item.closest('.tk-tree')?.getAttribute('tree-id') || null,
      parentExternalId: parent?.getAttribute('tree-id') || null,
      level,
      type: level === 1 ? 'chapter' : level === 2 ? 'section' : 'point',
      name: (anchor?.textContent || '').trim(),
      sourcePath: anchor?.getAttribute('data-href') || null,
      path: labels.filter(Boolean).join(' › '),
    };
  }).filter((item) => item.externalId && item.name));
}

function selectCatalogs(options, tree) {
  const byId = new Map(tree.map((node) => [String(node.externalId), node]));
  const enrich = (node) => {
    let current = node;
    let chapterExternalId = Number(node.level) === 1 ? String(node.externalId) : null;
    const visited = new Set();
    while (!chapterExternalId && current?.parentExternalId && !visited.has(current.parentExternalId)) {
      visited.add(current.parentExternalId);
      current = byId.get(String(current.parentExternalId));
      if (Number(current?.level) === 1) chapterExternalId = String(current.externalId);
    }
    return { ...node, chapterExternalId };
  };
  if (options.catalogIds.length > 0) {
    const missing = options.catalogIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new StopCrawlError(`目录树中未找到 catalog-id：${missing.join('、')}`, 'catalog_not_found');
    }
    return options.catalogIds.map((id) => enrich(byId.get(id)));
  }
  if (options.allCatalogs) {
    return tree
      .filter((node) => options.catalogLevels.includes(Number(node.level)))
      .map(enrich)
      .filter((node) => options.withinChapterIds.length === 0
        || options.withinChapterIds.includes(String(node.chapterExternalId)));
  }
  return options.chapterIds.map((id) => enrich(byId.get(String(id)) || ({
    externalId: String(id),
    textbookExternalId: options.textbookId,
    parentExternalId: null,
    level: 1,
    type: 'chapter',
    name: `章节 ${id}`,
    sourcePath: `/${options.bankPath}/zj${id}`,
    path: `章节 ${id}`,
  })));
}

function partitionCatalogsByChapter(catalogs, workerCount) {
  const count = Math.max(1, Number(workerCount) || 1);
  if (count === 1 || !Array.isArray(catalogs) || catalogs.length <= 1) {
    return [Array.isArray(catalogs) ? catalogs.slice() : []];
  }
  const chapterOrder = [];
  const grouped = new Map();
  for (const catalog of catalogs) {
    const chapterId = String(catalog.chapterExternalId || catalog.externalId);
    if (!grouped.has(chapterId)) {
      grouped.set(chapterId, []);
      chapterOrder.push(chapterId);
    }
    grouped.get(chapterId).push(catalog);
  }
  const size = Math.min(count, chapterOrder.length);
  const buckets = Array.from({ length: size }, () => []);
  chapterOrder.forEach((chapterId, index) => {
    buckets[index % size].push(...grouped.get(chapterId));
  });
  return buckets.filter((bucket) => bucket.length > 0);
}

function createMutex() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(() => task());
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

function isCascadeStopError(error) {
  return error instanceof StopCrawlError
    && error.code === 'signal'
    && /^收到 /.test(String(error.message || ''));
}

function pickWorkerFailure(failures) {
  const list = (failures || []).filter(Boolean);
  if (list.length === 0) return null;
  return list.find((error) => !isCascadeStopError(error)) || list[0];
}

function describeWorkerChapters(catalogs, tree) {
  const byId = new Map((tree || []).map((node) => [String(node.externalId), node]));
  const names = [];
  const seen = new Set();
  for (const catalog of catalogs) {
    const chapterId = String(catalog.chapterExternalId || catalog.externalId);
    if (seen.has(chapterId)) continue;
    seen.add(chapterId);
    const node = byId.get(chapterId);
    names.push(node?.name || catalog.name || chapterId);
  }
  return names;
}

function isListReadyState({ questionCount = 0, totalText = '', emptyText = '' } = {}) {
  if (Number(questionCount) > 0) return true;
  const normalizedTotal = String(totalText || '').replace(/\s+/g, '');
  if (/^0(?:\D|$)/.test(normalizedTotal)) return true;
  return /(?:暂无|没有|未找到)[^\n]{0,20}(?:题目|试题|数据|内容)/.test(String(emptyText || ''));
}

function nextCatalogPage(checkpoint, startPage, totalPages) {
  const next = Math.max(Number(startPage) || 1, (Number(checkpoint) || 0) + 1);
  if (Number(totalPages) > 0 && next > Number(totalPages)) return null;
  return next;
}

function jumpPlan(targetPage, gotoCap = SITE_PAGE_LIMIT) {
  const target = Math.max(1, Number(targetPage) || 1);
  const cap = Math.max(1, Number(gotoCap) || 1);
  if (target <= 1) return { goto: null, nextClicks: 0 };
  if (target <= cap) return { goto: target, nextClicks: 0 };
  return { goto: cap, nextClicks: target - cap };
}

function buildCatalogProgressTree({
  nodes = [],
  memberships = [],
  stats = {},
  currentByCatalog = {},
} = {}) {
  const questionsByCatalog = new Map();
  for (const row of memberships) {
    const catalogId = String(row.catalogExternalId || '');
    const questionId = String(row.questionExternalId || '');
    if (!catalogId || !questionId) continue;
    if (!questionsByCatalog.has(catalogId)) questionsByCatalog.set(catalogId, new Set());
    questionsByCatalog.get(catalogId).add(questionId);
  }
  const byId = new Map();
  const childrenOf = new Map();
  for (const node of nodes) {
    const id = String(node.externalId);
    byId.set(id, node);
    const parentId = node.parentExternalId ? String(node.parentExternalId) : '';
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(id);
  }
  const descendantCache = new Map();
  const descendantIds = (id) => {
    if (descendantCache.has(id)) return descendantCache.get(id);
    const ids = [id];
    for (const childId of childrenOf.get(id) || []) ids.push(...descendantIds(childId));
    descendantCache.set(id, ids);
    return ids;
  };
  const uniqueCount = (ids) => {
    const seen = new Set();
    for (const id of ids) {
      const questions = questionsByCatalog.get(id);
      if (!questions) continue;
      for (const questionId of questions) seen.add(questionId);
    }
    return seen.size;
  };
  const buildNode = (id) => {
    const node = byId.get(id);
    const stat = stats[id] || {};
    const expectedTotal = stat.expectedTotal == null ? null : Number(stat.expectedTotal);
    const expectedPages = stat.expectedPages == null ? null : Number(stat.expectedPages);
    const lastCompletedPage = Number(stat.lastCompletedPage || 0);
    const crawledUnique = uniqueCount(descendantIds(id));
    return {
      externalId: id,
      name: node.name,
      level: Number(node.level || 0),
      path: node.path || node.name,
      parentExternalId: node.parentExternalId ? String(node.parentExternalId) : null,
      expectedTotal,
      expectedPages,
      lastCompletedPage,
      crawledUnique,
      current: currentByCatalog[id] || null,
      children: (childrenOf.get(id) || []).map(buildNode),
    };
  };
  const roots = [];
  const seenRoot = new Set();
  for (const node of nodes) {
    const id = String(node.externalId);
    const parentId = node.parentExternalId ? String(node.parentExternalId) : '';
    if (parentId && byId.has(parentId)) continue;
    if (seenRoot.has(id)) continue;
    seenRoot.add(id);
    roots.push(buildNode(id));
  }
  const walkPages = (list, key) => list.reduce((sum, node) => (
    sum + Number(node[key] || 0) + walkPages(node.children, key)
  ), 0);
  const pagesDone = walkPages(roots, 'lastCompletedPage');
  const pagesTotal = walkPages(roots, 'expectedPages');
  return {
    questionUnique: uniqueCount(nodes.map((node) => String(node.externalId))),
    catalogCount: nodes.length,
    pagesDone,
    pagesTotal,
    progressPercent: pagesTotal > 0
      ? Math.min(100, Math.round((Math.min(pagesDone, pagesTotal) / pagesTotal) * 1000) / 10)
      : null,
    current: Object.values(currentByCatalog),
    catalogs: roots,
  };
}

function parsePagerState(raw = {}) {
  const pageCapacity = Number(raw.pageCapacity) > 0 ? Number(raw.pageCapacity) : 10;
  const total = Number(raw.total) >= 0 ? Number(raw.total) : 0;
  const currentPage = Number(raw.currentPage) > 0 ? Number(raw.currentPage) : 1;
  const totalPages = Math.max(1, Math.ceil((total || 1) / pageCapacity));
  const nextDisabled = Boolean(raw.nextDisabled) || currentPage >= totalPages;
  return {
    currentPage,
    totalPages,
    pageCapacity,
    total,
    hasNext: !nextDisabled,
  };
}

async function waitForListReady(page, timeout) {
  await page.waitForFunction(
    () => {
      const questionCount = document.querySelectorAll('.tk-quest-item').length;
      const totalText = document.querySelector(
        '.topic-ctrl-bar .count-box em, main article em',
      )?.textContent || '';
      const emptyText = Array.from(document.querySelectorAll(
        '.test-list, .empty, .empty-data, .no-data, [class*="empty"], [class*="no-data"]',
      )).map((element) => element.textContent || '').join('\n');
      if (questionCount > 0) return true;
      const normalizedTotal = String(totalText).replace(/\s+/g, '');
      if (/^0(?:\D|$)/.test(normalizedTotal)) return true;
      return /(?:暂无|没有|未找到)[^\n]{0,20}(?:题目|试题|数据|内容)/.test(emptyText);
    },
    null,
    { timeout },
  );
}

async function waitForListReadyChecked(page, options, timeout = options.timeout) {
  try {
    await waitForListReady(page, timeout);
  } catch (error) {
    await waitForHumanSliderIfNeeded(page, options);
    console.warn(`[列表] 列表未就绪，再等一次：${String(error.message).split('\n')[0]}`);
    await waitForListReady(page, options.timeout);
  }
  await detectBlockedPage(page);
}

async function extractListPage(page, baseUrl) {
  return page.evaluate((origin) => {
    const absolute = (value) => {
      if (!value) return null;
      try { return new URL(value, origin).href; } catch { return null; }
    };
    const normalized = (value) => String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
    const contentHash = async () => null;
    void contentHash;
    const items = Array.from(document.querySelectorAll('.test-list .tk-quest-item'));
    const hasListSurface = Boolean(
      document.querySelector('.test-list, .topic-ctrl-bar, .tk-pager, main article'),
    );
    const pageCapacity = Number(document.querySelector('.tk-pager')?.getAttribute('data-cap'))
      || items.length
      || 10;
    const totalText = document.querySelector('.topic-ctrl-bar .count-box em, main article em')?.textContent || '';
    const total = Number(totalText.replace(/\D/g, '')) || items.length;
    const pager = document.querySelector('.tk-pager');
    const next = pager?.querySelector('a[data-type="nextPage"]');
    const active = pager?.querySelector('a.page-num.active, a[data-type="switchPage"].active');
    const pagerState = {
      total: Number(pager?.getAttribute('data-sum')) || total,
      pageCapacity: Number(pager?.getAttribute('data-cap') || pager?.getAttribute('data-size')) || pageCapacity,
      currentPage: Number(active?.getAttribute('data-num')) || 1,
      nextDisabled: !next || next.classList.contains('disabled') || next.hasAttribute('hidden'),
    };
    const questions = items.map((item) => {
      const id = item.getAttribute('questionid');
      const addButton = item.querySelector('[quesid]');
      const info = Array.from(item.querySelectorAll('.ques-additional .info-cnt'))
        .map((element) => normalized(element.textContent));
      const difficultyText = info[1] || '';
      const coefficient = difficultyText.match(/\((\d+(?:\.\d+)?)\)/)?.[1] || addButton?.getAttribute('qdvalue');
      const difficultyLabel = (difficultyText.replace(/\s*\([^)]*\)\s*$/, '').trim()
        || addButton?.getAttribute('qdname') || null);
      const source = item.querySelector('.ques-src');
      const detail = item.querySelector('a.detail[href*="/2q"]');
      const content = item.querySelector('.exam-item__cnt');
      const html = content?.innerHTML?.trim() || null;
      const plainText = normalized(content?.innerText || content?.textContent || '');
      const assets = Array.from(content?.querySelectorAll('img[src]') || []).map((image) => ({
        url: absolute(image.getAttribute('src')),
        type: /\/formula\/|\.svg(?:$|\?)/i.test(image.getAttribute('src') || '') ? 'formula' : 'image',
      })).filter((asset) => asset.url);
      const knowledge = Array.from(item.querySelectorAll('.knowledge-list a.knowledge-item')).map((link) => {
        const href = link.getAttribute('href') || '';
        const ability = href.match(/tre\d+-(\d+)/);
        const point = href.match(/zsd(\d+)/);
        return {
          externalId: ability?.[1] || point?.[1] || normalized(link.textContent),
          name: normalized(link.textContent),
          kind: ability ? 'ability' : 'knowledge_point',
          evidenceType: 'provider_asserted',
        };
      });
      const tags = Array.from(item.querySelectorAll('.right-msg .tag'))
        .map((element) => normalized(element.textContent)).filter(Boolean);
      if (item.classList.contains('new') && !tags.includes('新题')) tags.push('新题');
      const usageTitles = Array.from(item.querySelectorAll('.exam-item__info [title]'))
        .map((element) => element.getAttribute('title') || '');
      const referenceLabel = normalized(
        item.querySelector('.look-more-src .info-txt')?.textContent
        || item.querySelector('.look-more-src')?.textContent
        || '',
      );
      const referencePapers = Array.from(item.querySelectorAll('.more-src-links a.src-item')).map((link) => ({
        name: normalized(link.getAttribute('title') || link.textContent),
        url: absolute(link.getAttribute('href')),
      })).filter((paper) => paper.name);
      return {
        externalId: id,
        bankId: Number(item.getAttribute('bankid')) || null,
        detailUrl: absolute(detail?.getAttribute('href')),
        sourceShort: normalized(source?.textContent) || null,
        sourceTitle: (source?.getAttribute('title') || '').replace(/^原始出处[：:]\s*/, '') || null,
        sourceUrl: absolute(source?.getAttribute('href')),
        questionType: info[0] || addButton?.getAttribute('qyname') || null,
        questionTypeId: addButton?.getAttribute('qyid') || null,
        difficultyLabel,
        difficultyCode: addButton?.getAttribute('qdid') || null,
        easeCoefficient: coefficient == null ? null : Number(coefficient),
        contentHtml: html,
        plainText,
        contentHash: null,
        subquestionCount: (plainText.match(/(?:^|\s|\n)[（(]\d+[)）]/g) || []).length,
        childCount: Number(addButton?.getAttribute('childnum')) || null,
        hasImage: assets.some((asset) => asset.type === 'image'),
        hasFormula: assets.some((asset) => asset.type === 'formula'),
        hasTable: Boolean(content?.querySelector('table')),
        isNew: item.classList.contains('new'),
        usageTitles,
        referenceLabel,
        referencePapers,
        providerUpdatedAt: null,
        answerHtml: null,
        analysisHtml: null,
        answerStatus: 'not_collected',
        solutionHtml: null,
        knowledge,
        assets,
        providerLabels: tags.map((value) => ({
          dimension: value === '新题' ? 'fresh' : 'provider_tag',
          value,
        })),
      };
    });
    return {
      total: pagerState.total || total,
      pageCapacity: pagerState.pageCapacity || pageCapacity,
      questions,
      hasListSurface,
      pager: pagerState,
    };
  }, baseUrl).then((parsed) => ({
    ...parsed,
    questions: (parsed.questions || []).map(applyListUsageMeta),
  }));
}

async function openCatalogList(page, catalog, gate, options) {
  const selector = `.tk-tree li.tree-node[tree-id="${catalog.externalId}"] > .tree-node-name a.tree-anchor`;
  const node = page.locator(selector);
  if (await node.count() > 0) {
    await gate.wait(`点击目录 ${catalog.name || catalog.externalId}`);
    try {
      await node.scrollIntoViewIfNeeded({ timeout: 3000 });
      await node.click({ timeout: Math.min(15000, options.timeout) });
      await waitForListReadyChecked(page, options);
      return;
    } catch (error) {
      if (error instanceof StopCrawlError) throw error;
      console.warn(
        `[目录] 点击「${catalog.name || catalog.externalId}」失败，改用地址打开：${String(error.message).split('\n')[0]}`,
      );
    }
  }
  await safeGoto(page, buildCatalogPageUrl(options, catalog, 1), gate, options, `打开目录 ${catalog.name || catalog.externalId}`);
  await waitForListReadyChecked(page, options);
}

async function readActiveListPage(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.tk-pager a.page-num.active, .tk-pager a[data-type="switchPage"].active');
    return Number(active?.getAttribute('data-num') || active?.textContent) || 1;
  });
}

async function readListQuestionIds(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.tk-quest-item[questionid]'))
    .map((item) => item.getAttribute('questionid'))
    .filter(Boolean)
    .join(','));
}

function questionListRequestParams(response) {
  if (!response || typeof response.url !== 'function' || typeof response.request !== 'function') return null;
  let parsed;
  try {
    parsed = new URL(response.url());
  } catch {
    return null;
  }
  if (parsed.pathname !== QUESTION_LIST_API_PATH) return null;
  const request = response.request();
  if (!request || String(request.method?.() || '').toUpperCase() !== 'POST') return null;
  const params = new URLSearchParams(String(request.postData?.() || ''));
  return Object.fromEntries(params.entries());
}

function parseQuestionListPayload(payload) {
  if (!payload || String(payload.code) !== '0' || !payload.data || typeof payload.data !== 'object') {
    throw new StopCrawlError(
      `题目列表接口返回异常：${JSON.stringify(payload ?? null).slice(0, 500)}`,
      'list_api_contract',
    );
  }
  const html = String(payload.data.html || '');
  const questionIds = Array.from(
    html.matchAll(/\bquestionid=["'](\d+)["']/gi),
    (match) => match[1],
  );
  return {
    questionIds,
    total: Number(payload.data.total || 0),
  };
}

function listQuestionIdsMatch(expectedIds, actualIds) {
  const expected = Array.isArray(expectedIds) ? expectedIds.map(String) : [];
  const actual = Array.isArray(actualIds) ? actualIds.map(String) : [];
  return expected.length === actual.length
    && expected.every((questionId, index) => questionId === actual[index]);
}

async function captureQuestionListResponse(page, action, matchesParams, options, label) {
  const responsePromise = page.waitForResponse((response) => {
    const params = questionListRequestParams(response);
    return Boolean(params && matchesParams(params));
  }, { timeout: options.timeout });
  try {
    await action();
  } catch (error) {
    responsePromise.catch(() => {});
    throw error;
  }
  const response = await responsePromise;
  const status = Number(response.status?.() || 0);
  if ([401, 403].includes(status)) {
    throw new StopCrawlError(`${label} 返回 HTTP ${status}，任务已熔断。`, `http_${status}`);
  }
  if (status >= 400) throw new Error(`${label} 返回 HTTP ${status}`);
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    await detectBlockedPage(page, LIST_CONTENT_SELECTOR);
    throw new StopCrawlError(
      `${label} 返回的题目列表不是有效 JSON：${String(error.message || '').split('\n')[0]}`,
      'list_api_contract',
    );
  }
  return {
    ...parseQuestionListPayload(payload),
    params: questionListRequestParams(response),
  };
}

async function waitForQuestionListDom(page, apiResult, expectedPage, options) {
  const expectedIds = apiResult.questionIds || [];
  try {
    await page.waitForFunction(({ pageNumber, questionIds }) => {
      const active = document.querySelector(
        '.tk-pager a.page-num.active, .tk-pager a[data-type="switchPage"].active',
      );
      const activePage = Number(active?.getAttribute('data-num') || active?.textContent) || 1;
      const actualIds = Array.from(document.querySelectorAll('.tk-quest-item[questionid]'))
        .map((item) => item.getAttribute('questionid'))
        .filter(Boolean);
      return activePage === pageNumber
        && actualIds.length === questionIds.length
        && actualIds.every((questionId, index) => questionId === questionIds[index]);
    }, { pageNumber: expectedPage, questionIds: expectedIds }, { timeout: options.timeout });
  } catch (error) {
    await detectBlockedPage(page, LIST_CONTENT_SELECTOR);
    const actualPage = await readActiveListPage(page);
    const actualIds = String(await readListQuestionIds(page)).split(',').filter(Boolean);
    throw new StopCrawlError(
      `题目列表校验失败：期望第 ${expectedPage} 页/${expectedIds.length} 题，`
        + `实际第 ${actualPage} 页/${actualIds.length} 题。`
        + `${String(error.message || '').split('\n')[0]}`,
      'list_api_contract',
    );
  }
  const actualIds = String(await readListQuestionIds(page)).split(',').filter(Boolean);
  if (!listQuestionIdsMatch(expectedIds, actualIds)) {
    throw new StopCrawlError('题目列表接口题号与页面 DOM 题号不一致。', 'list_api_contract');
  }
  await detectBlockedPage(page, LIST_CONTENT_SELECTOR);
}

async function jumpToListPageNumber(page, pageNumber, gate, options) {
  if (pageNumber <= 1) return;
  const plan = jumpPlan(pageNumber);
  if (plan.goto && plan.goto > 1) {
    const input = page.locator('.tk-pager .go-to__page, #iptGotoNum').first();
    const confirm = page.locator('.tk-pager a[data-type="confirmGoto"]').first();
    if (await input.count() === 0 || await confirm.count() === 0) {
      throw new StopCrawlError('列表页没有跳转分页控件。', 'pager_contract');
    }
    await gate.wait(`跳转到第 ${plan.goto} 页`);
    await input.fill(String(plan.goto));
    const apiResult = await captureQuestionListResponse(
      page,
      () => confirm.click(),
      (params) => params.curPage === String(plan.goto),
      options,
      `跳转到第 ${plan.goto} 页`,
    );
    await waitForQuestionListDom(page, apiResult, plan.goto, options);
    try {
      await page.waitForFunction((expected) => {
        const active = document.querySelector('.tk-pager a.page-num.active, .tk-pager a[data-type="switchPage"].active');
        return Number(active?.getAttribute('data-num') || active?.textContent) === expected;
      }, plan.goto, { timeout: options.timeout });
    } catch (error) {
      await detectBlockedPage(page);
      const landed = await readActiveListPage(page);
      if (landed !== plan.goto) {
        throw new StopCrawlError(
          `跳转到第 ${plan.goto} 页失败，当前第 ${landed} 页。${String(error.message || '').split('\n')[0]}`,
          'pager_contract',
        );
      }
    }
    await detectBlockedPage(page);
  }
  let current = await readActiveListPage(page);
  while (current < pageNumber) {
    const previousIds = await readListQuestionIds(page);
    console.log(`[列表] 跳页上限 ${SITE_PAGE_LIMIT}，从第 ${current} 页点击下一页直到第 ${pageNumber} 页`);
    const moved = await goToNextListPage(page, previousIds, gate, options);
    if (!moved) {
      throw new StopCrawlError(`无法从第 ${current} 页翻到第 ${pageNumber} 页。`, 'pager_contract');
    }
    current = await readActiveListPage(page);
  }
}

async function goToNextListPage(page, previousIds, gate, options) {
  const next = page.locator('.tk-pager a[data-type="nextPage"]').first();
  if (await next.count() === 0) return false;
  const disabled = await next.evaluate((el) => (
    el.classList.contains('disabled') || el.hasAttribute('hidden')
  ));
  if (disabled) return false;
  const expectedPage = await readActiveListPage(page) + 1;
  await gate.wait('点击列表下一页');
  const apiResult = await captureQuestionListResponse(
    page,
    () => next.click(),
    (params) => params.curPage === String(expectedPage),
    options,
    `翻到第 ${expectedPage} 页`,
  );
  await waitForQuestionListDom(page, apiResult, expectedPage, options);
  if (previousIds && String(apiResult.questionIds.join(',')) === String(previousIds)) {
    throw new StopCrawlError('点击下一页后接口返回了相同题目。', 'pagination_loop');
  }
  return true;
}

function finalizeQuestion(question) {
  const stable = normalizeWhitespace(question.contentHtml || question.plainText || '');
  const hasSeparatedSolution = hasPublicSolutionField(question.answerHtml)
    || hasPublicSolutionField(question.analysisHtml);
  const hasExplicitAnswerStatus = question.answerStatus != null
    && String(question.answerStatus).trim() !== '';
  const explicitStatus = normalizeAnswerStatus(question.answerStatus, '');
  // A login marker is authoritative even if a stale/legacy caller supplies a
  // contradictory public status or HTML payload.
  const answerStatus = question.loginRequired
    ? 'login_required'
    : (explicitStatus || (hasSeparatedSolution ? 'public_captured' : 'not_collected'));
  const publicSolution = answerStatus === 'public_captured';
  return {
    ...question,
    contentHash: stable ? sha256(stable) : null,
    listContentHash: question.listContentHash || (stable ? sha256(stable) : null),
    detailContentHash: question.detailContentHash || null,
    detailFetched: Boolean(question.detailFetched),
    subquestionCount: question.subquestionCount || countSubquestions(question.plainText),
    answerHtml: publicSolution ? (question.answerHtml || null) : null,
    analysisHtml: publicSolution ? (question.analysisHtml || null) : null,
    answerStatus,
    // A combined solution is retained only as compatibility evidence.  Never
    // let a restricted/not-visible response carry stale answer content.
    solutionHtml: answerStatus === 'public_captured'
      || (answerStatus === 'not_collected' && !hasExplicitAnswerStatus)
      ? (question.solutionHtml || null) : null,
  };
}

async function waitForDetailContent(page, timeout) {
  const selectors = [
    '.quest-content .quesroot',
    '.quesroot .quest-cnt',
    'main .quesroot',
    '.quest-content .exam-item__cnt',
  ];
  const deadline = Date.now() + timeout;
  let lastError;
  for (const selector of selectors) {
    const remaining = deadline - Date.now();
    if (remaining <= 200) break;
    try {
      await page.locator(selector).first().waitFor({
        state: 'attached',
        timeout: Math.min(remaining, Math.max(1500, Math.floor(timeout / selectors.length))),
      });
      return selector;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('详情页未出现题目容器');
}

async function extractDetailPage(page, baseUrl, includeVisibleSolutions) {
  return page.evaluate(({ origin, includeSolutions }) => {
    const absolute = (value) => {
      if (!value) return null;
      try { return new URL(value, origin).href; } catch { return null; }
    };
    const normalized = (value) => String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
    const isVisible = (element) => {
      if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      let current = element;
      while (current && current.nodeType === 1) {
        if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
        if (current.classList && Array.from(current.classList).some((name) => (
          /^(?:hidden|hide|d-none|is-hidden|none)$/i.test(name)
        ))) return false;
        const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
          ? window.getComputedStyle(current)
          : null;
        if (style && (
          style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
          || style.opacity === '0'
        )) return false;
        current = current.parentElement;
      }
      // getClientRects is the browser's layout-level visibility signal.  The
      // text fallback keeps this extractor usable on pages that render a
      // visible section before a layout pass has produced its rect.
      return typeof element.getClientRects !== 'function'
        || element.getClientRects().length > 0
        || normalized(element.textContent || '') !== ''
        || String(element.innerHTML || '').trim() !== '';
    };
    const hasContent = (element) => normalized(element?.textContent || '') !== ''
      || String(element?.innerHTML || '').trim() !== '';
    const visibleHtml = (selectors) => Array.from(document.querySelectorAll(selectors))
      .filter((element) => isVisible(element) && hasContent(element))
      .map((element) => element.outerHTML)
      .join('\n') || null;
    const root = document.querySelector('.quest-content .quesroot');
    const content = root?.querySelector('.quest-cnt');
    if (!root || !content) return null;
    const info = Array.from(root.querySelectorAll('.info-list .info-item'))
      .map((element) => normalized(element.textContent));
    const valueAfter = (prefix) => info.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || null;
    const id = root.getAttribute('questionid') || valueAfter('题号：');
    const type = valueAfter('题型：');
    const ease = Number(valueAfter('难度：'));
    const useCount = Number(valueAfter('引用次数：'));
    const html = content.innerHTML.trim();
    const plainText = normalized(content.innerText || content.textContent);
    const source = root.querySelector('.quest-exam .src-item');
    const updateText = normalized(root.querySelector('.exam-item__info .no-bound.info-item')?.textContent)
      .replace(/^更新时间[：:]\s*/, '') || null;
    const knowledge = Array.from(document.querySelectorAll('.answer-box .knowledges a.knowledge-name'))
      .map((link) => ({
        externalId: link.getAttribute('cid') || (link.getAttribute('href') || '').match(/zsd(\d+)/)?.[1],
        name: normalized(link.textContent),
        kind: 'knowledge_point',
        evidenceType: 'provider_asserted',
      })).filter((item) => item.externalId && item.name);
    for (const link of document.querySelectorAll('.answer-box .knowledges > a.knowledge-item')) {
      const href = link.getAttribute('href') || '';
      const ability = href.match(/tre\d+-(\d+)/);
      const name = normalized(link.textContent);
      if (ability && name) knowledge.push({
        externalId: ability[1], name, kind: 'ability', evidenceType: 'provider_asserted',
      });
    }
    const assets = Array.from(content.querySelectorAll('img[src]')).map((image) => ({
      url: absolute(image.getAttribute('src')),
      type: /\/formula\/|\.svg(?:$|\?)/i.test(image.getAttribute('src') || '') ? 'formula' : 'image',
    })).filter((asset) => asset.url);
    const loginRequired = Array.from(document.querySelectorAll(
      '.answer-box .need-login, .answer-box .login-required, '
      + '.answer-box [data-login-required="true"], .answer-box [data-require-login="true"]',
    )).some((element) => isVisible(element));
    const answerHtml = includeSolutions && !loginRequired
      ? visibleHtml('.answer-box .answer')
      : null;
    const analysisHtml = includeSolutions && !loginRequired
      ? visibleHtml('.answer-box .analysis, .answer-box .parse')
      : null;
    const solution = includeSolutions && !loginRequired
      ? [answerHtml, analysisHtml].filter(Boolean).join('\n') || null
      : null;
    const answerStatus = loginRequired
      ? 'login_required'
      : (includeSolutions
        ? (answerHtml || analysisHtml ? 'public_captured' : 'not_visible')
        : 'not_collected');
    return {
      externalId: id,
      bankId: Number(root.getAttribute('bankid')) || null,
      detailUrl: location.href,
      sourceShort: normalized(source?.textContent) || null,
      sourceTitle: (source?.getAttribute('title') || '').replace(/^原始出处[：:]\s*/, '') || null,
      sourceUrl: absolute(root.querySelector('.more-src-links a[href]')?.getAttribute('href')),
      questionType: type,
      questionTypeId: root.querySelector('[quesid]')?.getAttribute('qyid') || null,
      difficultyLabel: root.querySelector('[quesid]')?.getAttribute('qdname') || null,
      difficultyCode: root.querySelector('[quesid]')?.getAttribute('qdid') || null,
      easeCoefficient: Number.isFinite(ease) ? ease : null,
      contentHtml: html,
      plainText,
      contentHash: null,
      subquestionCount: (plainText.match(/(?:^|\s|\n)[（(]\d+[)）]/g) || []).length,
      childCount: Number(root.querySelector('[quesid]')?.getAttribute('childnum')) || null,
      hasImage: assets.some((asset) => asset.type === 'image'),
      hasFormula: assets.some((asset) => asset.type === 'formula'),
      hasTable: Boolean(content.querySelector('table')),
      isNew: false,
      useCount: Number.isFinite(useCount) ? useCount : null,
      providerUpdatedAt: updateText,
      answerHtml,
      analysisHtml,
      answerStatus,
      solutionHtml: solution,
      knowledge,
      assets,
      providerLabels: [],
      loginRequired,
    };
  }, { origin: baseUrl, includeSolutions: includeVisibleSolutions });
}

function mergeQuestion(listQuestion, detailQuestion) {
  if (!detailQuestion) return finalizeQuestion(listQuestion);
  const mergedKnowledge = new Map();
  for (const item of [...(listQuestion.knowledge || []), ...(detailQuestion.knowledge || [])]) {
    mergedKnowledge.set(`${item.kind}:${item.externalId}`, item);
  }
  const mergedAssets = new Map();
  for (const item of [...(listQuestion.assets || []), ...(detailQuestion.assets || [])]) {
    mergedAssets.set(item.url, item);
  }
  const detailStable = normalizeWhitespace(detailQuestion.contentHtml || detailQuestion.plainText || '');
  const merged = finalizeQuestion({
    ...listQuestion,
    ...Object.fromEntries(Object.entries(detailQuestion).filter(([, value]) => value != null && value !== '')),
    isNew: listQuestion.isNew,
    detailContentHash: detailStable ? sha256(detailStable) : null,
    detailFetched: true,
    providerLabels: listQuestion.providerLabels || [],
    knowledge: Array.from(mergedKnowledge.values()),
    assets: Array.from(mergedAssets.values()),
  });
  if (['login_required', 'not_visible'].includes(merged.answerStatus)) {
    merged.answerHtml = null;
    merged.analysisHtml = null;
    merged.solutionHtml = null;
  }
  return merged;
}

function saveRawHtml(store, runId, dataDir, type, key, url, html) {
  const capturedAt = nowIso();
  const datePart = capturedAt.slice(0, 10);
  const relative = path.join(
    'raw',
    datePart,
    `run-${runId}`,
    `${safeFilePart(type)}-${safeFilePart(key)}.html.gz`,
  );
  const target = path.join(dataDir, relative);
  const compressed = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 6 });
  writeFileAtomic(target, compressed);
  store.saveSnapshot(runId, type, url, sha256(html), target);
  return target;
}

function extensionForAsset(url, mimeType) {
  const byMime = {
    'image/svg+xml': '.svg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  if (byMime[mimeType]) return byMime[mimeType];
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '.bin';
}

async function downloadAsset(context, gate, options, asset) {
  const url = assertAllowedUrl(asset.url, ALLOWED_ASSET_HOSTS);
  await gate.wait(`下载素材 ${path.basename(new URL(url).pathname)}`);
  const response = await context.request.get(url, { timeout: options.timeout, failOnStatusCode: false });
  const status = response.status();
  if ([401, 403, 429].includes(status)) {
    throw new StopCrawlError(`素材请求返回 HTTP ${status}，任务已熔断。`, `asset_http_${status}`);
  }
  if (status >= 400) {
    console.warn(`[素材] HTTP ${status}，跳过 ${url}`);
    return {
      ...asset,
      localPath: null,
      sha256: null,
      mimeType: null,
      byteSize: null,
    };
  }
  const lengthHeader = Number(response.headers()['content-length'] || 0);
  const maxBytes = 10 * 1024 * 1024;
  if (lengthHeader > maxBytes) throw new Error(`素材超过 10MB 上限：${url}`);
  const body = await response.body();
  if (body.length > maxBytes) throw new Error(`素材超过 10MB 上限：${url}`);
  const digest = sha256(body);
  const mimeType = (response.headers()['content-type'] || '').split(';')[0].trim() || null;
  const ext = extensionForAsset(url, mimeType);
  const relative = path.join('assets', digest.slice(0, 2), `${digest}${ext}`);
  const target = path.join(options.dataDir, relative);
  if (!fs.existsSync(target)) writeFileAtomic(target, body);
  return {
    ...asset,
    localPath: target,
    sha256: digest,
    mimeType,
    byteSize: body.length,
  };
}

function createConcurrencyLimit(max) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const queue = [];
  const kick = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          kick();
        });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    kick();
  });
}

function createAssetDownloader({ context, options, store, withStore, counters, session }) {
  const gate = new PoliteGate(options.assetDelayMin || 80, options.assetDelayMax || 220);
  const limit = createConcurrencyLimit(options.assetConcurrency || 4);
  const cache = new Map();
  const failed = new Set();
  ensureDir(path.join(options.dataDir, 'assets'));

  const ensure = (asset) => {
    if (!asset?.url) return Promise.resolve(asset);
    if (cache.has(asset.url)) return cache.get(asset.url);
    const work = limit(async () => {
      const existing = await withStore(() => store.getAssetByUrl(asset.url));
      if (existing?.local_path && fs.existsSync(existing.local_path)) {
        return {
          ...asset,
          localPath: existing.local_path,
          sha256: existing.sha256,
          mimeType: existing.mime_type,
          byteSize: existing.byte_size,
        };
      }
      const downloaded = await downloadAsset(context, gate, options, asset);
      if (downloaded.localPath) {
        await withStore(() => store.updateAssetFileByUrl(asset.url, downloaded));
        counters.assetsDownloaded += 1;
        if (counters.assetsDownloaded === 1 || counters.assetsDownloaded % 50 === 0) {
          console.log(`[素材] 已下载 ${counters.assetsDownloaded} 张 → ${path.relative(options.dataDir, downloaded.localPath)}`);
        }
      } else {
        failed.add(asset.url);
      }
      return downloaded;
    });
    cache.set(asset.url, work);
    return work;
  };

  const backfill = async () => {
    console.log('[素材] 开始补下采集库中尚未落盘的题图/公式');
    while (!session.signalName) {
      const batch = (await withStore(() => store.listMissingAssetUrls(40)))
        .filter((row) => row.source_url && !failed.has(row.source_url));
      if (batch.length === 0) {
        console.log(`[素材] 补下完成，本次新下载 ${counters.assetsDownloaded} 张`);
        return;
      }
      const pending = batch.filter((row) => !cache.has(row.source_url));
      if (pending.length === 0) {
        await Promise.all(batch.map((row) => cache.get(row.source_url)));
        continue;
      }
      await Promise.all(pending.map((row) => {
        let type = row.asset_type;
        try { type = type || classifyAsset(row.source_url); } catch { type = 'image'; }
        return ensure({ url: row.source_url, type });
      }));
    }
  };

  return { ensure, backfill };
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

function printStatus(status) {
  console.log('当前数据量：', status.counts);
  if (status.recentRuns.length === 0) {
    console.log('暂无同步记录。');
    return;
  }
  console.table(status.recentRuns);
}

function createLazyCollectorPage(createPage) {
  let page = null;
  return async () => {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      page = await createPage();
    }
    return page;
  };
}

async function crawlAssignedCatalogs({
  page,
  getDetailPage,
  context,
  catalogs,
  workerId,
  store,
  withStore,
  options,
  textbookTree,
  filterState,
  gate,
  runId,
  counters,
  session,
  assets,
}) {
  const tag = workerId ? `[W${workerId}] ` : '';
  for (const catalog of catalogs) {
    const chapterId = catalog.chapterExternalId || catalog.externalId;
    const filterJson = JSON.stringify(filterState);
    const scopeKey = sha256(`${PROVIDER}|catalog:${catalog.externalId}|${filterJson}`);
    const checkpoint = options.resume
      ? await withStore(() => (
        options.resumeRunId != null
          ? store.getRunCheckpoint(runId, scopeKey)
          : store.getCheckpoint(scopeKey)
      ))
      : 0;
    let previousIds = null;
    await openCatalogList(page, catalog, gate, options);
    const preview = await extractListPage(page, options.baseUrl);
    const previewPager = parsePagerState(preview.pager || {
      total: preview.total,
      pageCapacity: preview.pageCapacity,
    });
    const effectiveStart = nextCatalogPage(checkpoint, options.startPage, previewPager.totalPages);
    await withStore(() => {
      store.saveCatalogListStats({
        scopeKey,
        catalogId: catalog.externalId,
        chapterId,
        filterJson,
        expectedTotal: previewPager.total,
        pageCapacity: previewPager.pageCapacity,
        expectedPages: previewPager.totalPages,
        lastCompletedPage: effectiveStart == null ? previewPager.totalPages : checkpoint,
      });
      store.saveSyncProgress({
        runId,
        workerId,
        catalog,
        currentPage: effectiveStart == null ? previewPager.totalPages : effectiveStart,
        expectedPages: previewPager.totalPages,
        expectedTotal: previewPager.total,
      });
    });
    if (effectiveStart == null) {
      console.log(`${tag}[目录] ${catalog.path || catalog.name} 已抓完 ${previewPager.totalPages} 页，跳过`);
      continue;
    }
    const lastRequestedPage = options.maxPagesProvided
      ? (effectiveStart + options.maxPages - 1)
      : previewPager.totalPages;
    if (lastRequestedPage < previewPager.totalPages) counters.truncated = true;
    console.log(`${tag}[目录] ${catalog.path || catalog.name}（${catalog.externalId}），从第 ${effectiveStart} 页开始`);
    if (effectiveStart > 1) {
      await jumpToListPageNumber(page, effectiveStart, gate, options);
    }

    let pageNumber = effectiveStart;
    while (pageNumber <= lastRequestedPage) {
      if (session.signalName) throw new StopCrawlError(`收到 ${session.signalName}，任务安全停止。`, 'signal');
      if (options.limit > 0 && session.processed >= options.limit) break;
      const listUrl = page.url();
      console.log(`${tag}[列表] 第 ${pageNumber} 页 ${listUrl}`);
      await waitForListReadyChecked(page, options);
      const html = await page.content();
      if (options.saveRaw) {
        await withStore(() => saveRawHtml(
          store,
          runId,
          options.dataDir,
          'list',
          `${catalog.externalId}-p${pageNumber}`,
          listUrl,
          html,
        ));
      }
      const nodes = textbookTree.length > 0 ? textbookTree : await extractTree(page);
      const parsed = await extractListPage(page, options.baseUrl);
      if (!parsed.hasListSurface) {
        throw new StopCrawlError('列表页没有题库容器，可能发生页面契约变化。', 'contract_empty');
      }
      const pageIds = parsed.questions.map((item) => item.externalId).filter(Boolean).join(',');
      if (!pageIds) {
        if (parsed.total === 0) {
          console.log(`${tag}[列表] 该目录暂无题目，记录空页断点并继续下一个目录。`);
          await withStore(() => {
            store.savePageTransaction({
              runId,
              textbookExternalId: options.textbookId,
              scopeKey,
              chapterId,
              filterJson,
              pageNumber,
              nodes,
              questions: [],
              facets: filterFacets(options),
              catalog,
            });
            store.saveCatalogListStats({
              scopeKey,
              catalogId: catalog.externalId,
              chapterId,
              filterJson,
              expectedTotal: 0,
              pageCapacity: previewPager.pageCapacity,
              expectedPages: 1,
              lastCompletedPage: pageNumber,
            });
          });
          counters.pagesOk += 1;
          break;
        }
        throw new StopCrawlError('列表页没有解析到题目，可能发生页面契约变化。', 'contract_empty');
      }
      if (previousIds === pageIds) {
        throw new StopCrawlError('连续页面返回相同题目，已停止以避免分页死循环。', 'pagination_loop');
      }
      previousIds = pageIds;
      const pager = parsePagerState(parsed.pager || {
        total: parsed.total,
        pageCapacity: parsed.pageCapacity,
      });
      console.log(`${tag}[列表] 总题数 ${pager.total}，第 ${pager.currentPage}/${pager.totalPages} 页，本页 ${parsed.questions.length} 道`);

      const processedQuestions = [];
      let completedWholePage = true;
      for (const rawListQuestion of parsed.questions) {
        if (session.signalName) {
          completedWholePage = false;
          break;
        }
        if (options.limit > 0 && session.processed >= options.limit) {
          completedWholePage = false;
          break;
        }
        if (!rawListQuestion.externalId) continue;
        let question = finalizeQuestion(rawListQuestion);
        const existing = await withStore(() => store.getQuestion(question.externalId));
        const listContentUnchanged = existing?.list_content_hash
          && existing.list_content_hash === question.listContentHash;
        const shouldFetchDetail = shouldFetchQuestionDetail(
          question,
          existing,
          options,
          listContentUnchanged,
        );

        if (shouldFetchDetail && question.detailUrl) {
          const fallback = options.detailFallback && !options.details && !options.refreshDetails;
          console.log(`${tag}[详情] ${question.externalId}${fallback ? ' 列表缺题干或图片，改走详情' : ''}`);
          const detailPage = await getDetailPage();
          try {
            await safeGoto(detailPage, question.detailUrl, gate, options, `题目 ${question.externalId}`);
            await waitForDetailContent(detailPage, options.timeout);
            const detailHtml = await detailPage.content();
            if (options.saveRaw) {
              await withStore(() => saveRawHtml(
                store,
                runId,
                options.dataDir,
                'detail',
                question.externalId,
                question.detailUrl,
                detailHtml,
              ));
            }
            const detail = await extractDetailPage(
              detailPage,
              options.baseUrl,
              options.includeVisibleSolutions,
            );
            if (!detail || String(detail.externalId) !== String(question.externalId)) {
              throw new StopCrawlError(`详情页 ${question.externalId} 解析契约不匹配。`, 'detail_contract');
            }
            question = mergeQuestion(question, detail);
            counters.detailsFetched += 1;
          } catch (error) {
            if (error instanceof StopCrawlError) throw error;
            try { await detectBlockedPage(detailPage); } catch (blocked) {
              if (blocked instanceof StopCrawlError) throw blocked;
            }
            console.warn(
              `${tag}[跳过] 题目 ${question.externalId} 详情失败，保留列表数据：${String(error.message).split('\n')[0]}`,
            );
            await withStore(() => store.recordError(runId, question.detailUrl, 'detail', error));
            counters.errors += 1;
          }
        }

        if (assets && question.assets.length > 0) {
          const seenUrls = new Set();
          question.assets = await Promise.all(question.assets.filter((asset) => {
            if (!asset.url || seenUrls.has(asset.url)) return false;
            seenUrls.add(asset.url);
            return true;
          }).map((asset) => assets.ensure(asset)));
        }

        processedQuestions.push(question);
        session.processed += 1;
        counters.questionsSeen += 1;
      }

      if (processedQuestions.length > 0) {
        const result = await withStore(() => {
          const saved = store.savePageTransaction({
            runId,
            textbookExternalId: options.textbookId,
            scopeKey,
            chapterId,
            filterJson,
            pageNumber: completedWholePage ? pageNumber : Math.max(0, pageNumber - 1),
            nodes,
            questions: processedQuestions,
            facets: filterFacets(options),
            catalog,
          });
          if (completedWholePage) {
            store.saveCatalogListStats({
              scopeKey,
              catalogId: catalog.externalId,
              chapterId,
              filterJson,
              expectedTotal: pager.total,
              pageCapacity: pager.pageCapacity,
              expectedPages: pager.totalPages,
              listSeenIncrement: processedQuestions.length,
              lastCompletedPage: pageNumber,
            });
            store.saveSyncProgress({
              runId,
              workerId,
              catalog,
              currentPage: pageNumber,
              expectedPages: pager.totalPages,
              expectedTotal: pager.total,
            });
          }
          return saved;
        });
        counters.questionsInserted += result.inserted;
        counters.questionsUpdated += result.updated;
      }

      if (completedWholePage) counters.pagesOk += 1;
      else {
        counters.truncated = true;
        console.log(`${tag}[断点] 本页因 --limit 未完整处理，下次会安全重放本页并去重。`);
      }
      if (!completedWholePage) break;
      if (pageNumber >= pager.totalPages || pageNumber >= lastRequestedPage || !pager.hasNext) break;
      // Use the site's explicit page-number control for every page.  The
      // resulting question/list response is validated against the rendered
      // DOM inside jumpToListPageNumber before the checkpoint may advance.
      await jumpToListPageNumber(page, pageNumber + 1, gate, options);
      pageNumber += 1;
    }
    if (options.limit > 0 && session.processed >= options.limit) {
      counters.truncated = true;
      break;
    }
  }
}

function isTransientCrawlError(error) {
  if (!error) return false;
  const cause = error.cause;
  return isTransientResumeError({
    message: [
      error.message || error,
      error.name,
      cause?.code,
      cause?.message,
    ].filter(Boolean).join('\n'),
  }, [{
    error_code: error.code || error.name || cause?.code,
    stage: error.stage,
    message: [error.message || error, cause?.code, cause?.message].filter(Boolean).join('\n'),
  }]);
}

function hasSafePartialRun(store, runId, counters = {}) {
  const counts = store.runSnapshotCounts(runId);
  if (!(counts.catalogCount > 0
    && counts.questionCount > 0
    && counts.questionCatalogCount > 0)) return false;
  if (Number(counters.pagesOk || 0) > 0) return true;
  // A resumed child starts with the source's copied complete pages.  A
  // transient failure before its first newly fetched page is still a safe
  // interrupted checkpoint because that inherited snapshot is present.
  const run = store.getRun(runId);
  const scope = parseScopeObject(run?.scope_json);
  return Number(scope.resumeFromRunId || 0) > 0 || (
    counts.catalogCount > 0
    && counts.questionCount > 0
    && counts.questionCatalogCount > 0
  );
}

async function runSync(options) {
  if (!options.acknowledgeSourcePolicy) {
    throw new Error(
      '运行前必须传 --acknowledge-source-policy，确认已核对来源站规则、授权范围和内容使用边界。',
    );
  }
  if (!options.namedTextbook) resolveSyncScope(options);

  let playwright;
  try {
    playwright = require('playwright-core');
  } catch {
    const configured = process.env.PLAYWRIGHT_CORE_PATH;
    if (!configured) throw new Error('缺少 playwright-core。请先在 collector/ 目录运行 npm install。');
    try {
      playwright = require(configured);
      console.warn(`[环境] 使用 PLAYWRIGHT_CORE_PATH=${configured}。`);
    } catch {
      throw new Error(`无法加载 PLAYWRIGHT_CORE_PATH=${configured}。`);
    }
  }

  ensureDir(options.dataDir);
  ensureDir(options.profileDir);
  const store = new SyncStore(options.dbPath, { dataDir: options.dataDir });
  let releaseLock;
  try {
    releaseLock = acquireLock(`${options.dbPath}.lock`);
  } catch (error) {
    store.close();
    throw error;
  }
  const filterState = buildFilterState(options);
  const scope = {
    chapterIds: options.chapterIds,
    textbookId: options.textbookId,
    catalogLevels: options.catalogLevels,
    catalogIds: options.catalogIds,
    allCatalogs: options.allCatalogs,
    withinChapterIds: options.withinChapterIds,
    filters: filterState,
    startPage: options.startPage,
    maxPages: options.maxPages,
    details: options.details,
    detailFallback: options.detailFallback,
    refreshDetails: options.refreshDetails,
    includeVisibleSolutions: options.includeVisibleSolutions,
    downloadAssets: options.downloadAssets,
    requireDetails: options.details === true || options.refreshDetails === true,
    requireAssets: options.downloadAssets === true,
    limit: options.limit,
    maxPagesProvided: options.maxPagesProvided,
    truncated: false,
  };
  if (options.resumeRunId != null) scope.resumeFromRunId = options.resumeRunId;
  let runId;
  try {
    runId = store.beginRun(scope);
  } catch (error) {
    // Resume validation happens inside beginRun's atomic child-run
    // transaction.  It can reject before the crawl's normal try/finally, so
    // release the process lock and close SQLite explicitly here.
    store.close();
    releaseLock?.();
    throw error;
  }
  const counters = {
    pagesOk: 0,
    questionsSeen: 0,
    questionsInserted: 0,
    questionsUpdated: 0,
    detailsFetched: 0,
    assetsDownloaded: 0,
    errors: 0,
    truncated: false,
  };
  const gate = new PoliteGate(options.delayMin, options.delayMax);
  let context;
  const session = { signalName: null, processed: 0 };
  const onSignal = (name) => {
    session.signalName = name;
    console.warn(`\n[停止] 收到 ${name}，将在当前安全点结束。`);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let finalStatus = 'success';
  let finalMessage = null;

  try {
    console.log(`[启动] run=${runId}，数据库：${options.dbPath}`);
    if (options.resumeRunId != null) {
      console.log(`[续采] run=${runId} source-run=${options.resumeRunId} status=running`);
    }
    applyInitialChromeMode(options);
    console.log(`[环境] ${describeChromeMode(options)}`);
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
        const listPage = await createPage();
        if (options.namedTextbook) {
          await resolveNamedTextbook(listPage, gate, options);
        } else {
          await loadCatalogTree(listPage, buildListUrl(options, options.chapterIds[0], 1), gate, options);
        }
        return { context: next, createPage, listPage };
      } catch (error) {
        await closeCollectorContext(next);
        throw error;
      }
    };
    let bootSession;
    try {
      bootSession = await boot();
    } catch (error) {
      if (!canFallbackToHeaded(options, error)) throw error;
      console.warn(`[环境] 无头被防护阻断，改用有头 Chrome 重试：${String(error.message).split('\n')[0]}`);
      options.headless = false;
      bootSession = await boot();
    }
    context = bootSession.context;
    const createPage = bootSession.createPage;
    const listPage = bootSession.listPage;
    const textbookTree = await extractTree(listPage);
    if (textbookTree.length === 0) {
      throw new StopCrawlError('没有解析到教材目录树。', 'tree_contract');
    }
    store.saveRunCatalogTree(runId, options.textbookId, textbookTree);
    const catalogs = selectCatalogs(options, textbookTree);
    const assignments = partitionCatalogsByChapter(catalogs, options.workers);
    console.log(`[目录] 发现 ${textbookTree.length} 个节点，本次同步 ${catalogs.length} 个节点`);
    console.log(`[并行] ${assignments.length} 个工作标签（--workers ${options.workers}），同一 Chrome 按章分配`);
    assignments.forEach((assigned, index) => {
      const chapters = describeWorkerChapters(assigned, textbookTree);
      console.log(`[并行] W${index + 1}：${chapters.join('、')}（${assigned.length} 个节点）`);
    });

    const textbookUrl = listPage.url();
    const withStore = createMutex();
    const assets = options.downloadAssets
      ? createAssetDownloader({ context, options, store, withStore, counters, session })
      : null;
    if (assets) {
      console.log(`[素材] 题图/公式保存到 ${path.join(options.dataDir, 'assets')}（按内容哈希去重）`);
    }
    const jobs = assignments.map(async (assigned, index) => {
      const workerGate = new PoliteGate(options.delayMin, options.delayMax);
      workerGate.nextAt = Date.now() + (index * 1200);
      const page = index === 0
        ? listPage
        : await (async () => {
          const workerPage = await createPage();
          await loadCatalogTree(workerPage, textbookUrl, workerGate, options);
          return workerPage;
        })();
      const getDetailPage = createLazyCollectorPage(
        () => createPage(),
      );
      try {
        await crawlAssignedCatalogs({
          page,
          getDetailPage,
          context,
          catalogs: assigned,
          workerId: assignments.length > 1 ? index + 1 : 0,
          store,
          withStore,
          options,
          textbookTree,
          filterState,
          gate: workerGate,
          runId,
          counters,
          session,
          assets,
        });
      } catch (error) {
        const tag = assignments.length > 1 ? `[W${index + 1}] ` : '';
        console.error(`${tag}[错误] ${String(error.message || error).split('\n')[0]}`);
        if (error instanceof StopCrawlError && ['challenge', 'robots_disallowed', 'tree_contract', 'contract_empty'].includes(error.code)) {
          session.signalName = session.signalName || error.code;
        }
        throw error;
      }
    });
    if (assets) {
      jobs.push((async () => {
        try {
          await assets.backfill();
        } catch (error) {
          console.error(`[素材] [错误] ${String(error.message || error).split('\n')[0]}`);
          if (error instanceof StopCrawlError && ['challenge', 'robots_disallowed'].includes(error.code)) {
            session.signalName = session.signalName || error.code;
          }
          throw error;
        }
      })());
    }
    const workerResults = await Promise.allSettled(jobs);
    const failures = workerResults
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason);
    const failure = pickWorkerFailure(failures);
    if (failure) throw failure;
    const readiness = store.snapshotReadiness(runId, counters);
    if (!readiness.complete) {
      throw new Error(readiness.reason || '运行快照未完整封存');
    }
    // A signal can arrive just after the last worker reaches its loop exit.
    // Preserve cancellation semantics instead of accidentally publishing a
    // successful run whose operator requested SIGINT/SIGTERM.
    if (session.signalName === 'SIGINT' || session.signalName === 'SIGTERM') {
      throw new StopCrawlError(`收到 ${session.signalName}，任务安全停止。`, 'signal');
    }
  } catch (error) {
    counters.errors += 1;
    store.recordError(runId, null, 'run', error);
    const operatorCancelled = session.signalName === 'SIGINT' || session.signalName === 'SIGTERM';
    const resumableInterruption = !operatorCancelled
      && isTransientCrawlError(error)
      && hasSafePartialRun(store, runId, counters);
    finalStatus = operatorCancelled
      ? 'cancelled'
      : (resumableInterruption
        ? 'interrupted'
        : (error instanceof StopCrawlError ? 'blocked' : 'failed'));
    finalMessage = error.message;
    throw error;
  } finally {
    try { if (context) await context.close(); } catch {}
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    store.finishRun(runId, finalStatus, counters, finalMessage);
    const snapshotCounts = store.runSnapshotCounts(runId);
    store.close();
    releaseLock?.();
    console.log(
      `[快照] run=${runId} status=${finalStatus} catalogs=${snapshotCounts.catalogCount} questions=${snapshotCounts.questionCount} questionCatalogs=${snapshotCounts.questionCatalogCount} questionTags=${snapshotCounts.questionTagCount} questionAssets=${snapshotCounts.questionAssetCount}`,
    );
    console.log(`[完成] run=${runId} status=${finalStatus}`, counters);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (options.statusOnly || options.catalogProgress) {
      const store = new SyncStore(options.dbPath);
      try {
        if (options.catalogProgress) {
          console.log(JSON.stringify(store.loadCatalogProgress(), null, 2));
        } else {
          printStatus(store.status());
        }
      } finally { store.close(); }
      return;
    }
    await runSync(options);
  } catch (error) {
    console.error(`\n[错误] ${error.message}`);
    if (!options?.help) console.error('使用 --help 查看参数。');
    process.exitCode = 1;
  }
}

module.exports = {
  ANSWER_STATUSES,
  CATEGORY_IDS,
  DEFAULT_CHAPTER_ID,
  DEFAULT_TEXTBOOK_ID,
  DIFFICULTY_IDS,
  QUESTION_TYPE_IDS,
  SCENE_IDS,
  SORT_IDS,
  StopCrawlError,
  SyncStore,
  buildCatalogListUrl,
  buildCatalogPageUrl,
  buildFilterState,
  buildFilterTokens,
  buildListUrl,
  classifyAsset,
  countSubquestions,
  createLazyCollectorPage,
  filterFacets,
  finalizeQuestion,
  extractDetailPage,
  isListReadyState,
  parsePagerState,
  nextCatalogPage,
  jumpPlan,
  listNeedsDetailFallback,
  lookupBootstrapChapter,
  pickExactByName,
  mergeQuestion,
  normalizeWhitespace,
  parseArgs,
  parseDifficultyText,
  parseListUsageMeta,
  parseQuestionListPayload,
  applyListUsageMeta,
  questionListRequestParams,
  listQuestionIdsMatch,
  resolveMappedId,
  resolveSyncScope,
  selectCatalogs,
  shouldFetchQuestionDetail,
  partitionCatalogsByChapter,
  pickWorkerFailure,
  buildCatalogProgressTree,
  sha256,
  checkpointFilterJson,
  checkpointScopeKey,
  copyResumeRunCheckpoints,
  copyResumeSnapshotRows,
  isResumablePartialRun,
  isTransientResumeError,
  normalizeResumeScope,
  resumeScopeDifferences,
  validateResumeSourceRun,
  validateResumeSourceRunInDb,
};

if (require.main === module) {
  main();
}
