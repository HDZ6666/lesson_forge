'use strict';

/**
 * CLI surface of the question-list collector: argument parsing, help text and
 * the process entry.  Behaviour and flags are unchanged; `--events-stdout` is
 * a hidden diagnostic that mirrors structured events to stdout.
 */

const path = require('node:path');
const process = require('node:process');

const {
  DEFAULT_API_PATH,
  DEFAULT_ASSET_CONCURRENCY,
  DEFAULT_BANK_ID,
  DEFAULT_BANK_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_DELAY_MAX,
  DEFAULT_DELAY_MIN,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGINATION_SAFETY_LIMIT,
  DEFAULT_TEXTBOOK_ID,
  DEFAULT_TIMEOUT,
  DEFAULT_VERIFICATION_POLL,
  DEFAULT_VERIFICATION_PROBE_INTERVAL,
  DEFAULT_VERIFICATION_TIMEOUT,
  MAX_ASSET_CONCURRENCY,
  MAX_LIST_CONCURRENCY,
  MAX_SESSION_SWITCHES,
  SITE_PAGE_LIMIT,
} = require('../sources/zujuan/constants.cjs');
const { parsePositiveInt } = require('../shared/utils.cjs');
const { catalogSafetyPageLimit } = require('../policies/pagination.cjs');
const { QuestionSyncStore } = require('../storage/question_store/index.cjs');
const { createProcessEventEmitter } = require('../jobs/events.cjs');
const { runSync } = require('../jobs/question_run.cjs');
const { assertMathSource } = require('../sources/registry.cjs');

function usage() {
  return `
题库基础全量同步（独立 collector 先行验证脚本）

用法：
  cd collector && npm run sync:zujuan:questions -- --textbook-id 260617

核心选项：
  --textbook-id <id>       教材来源 ID，默认 260617
  --bank-id <id>          题库 ID，默认 2
  --bank-path <path>      题库路径，默认 czsx
  --catalog-id <id>       只抓指定目录，可重复
  --catalog-level <n>     目录层级，可重复；默认抓章/小节/知识点
  --max-catalogs <n>      本次最多目录数，0 表示不限
  --start-page <n>        每个目录起始页，默认 1
  --max-pages <n>         每个目录最多页数；不传则按来源 total 动态扩展
  --limit-to-1000-pages   每个目录最多请求 1000 页，达到边界后按策略正常结束
  --catalog-page-limit <n> 每个目录的页数上限（1～10000），到达后保留未完整标记并继续其他目录
  --safety-page-limit <n> 分页安全上限，默认 10000，只防止无限非空页
  --limit <n>             本次最多保存题数，便于验收；0 表示不限
  --concurrency <n>       同一 Cookie 列表并发路数，默认 8，最大 16
  --asset-concurrency <n> 素材（题图/公式）预取并发数，默认 8，最大 32；只作用于静态素材主机

运行选项：
  --headless              显式使用无头 Chrome；默认有头 Chrome
  --cdp-url <url>         连接已有 Chrome 的 CDP（如 http://127.0.0.1:9222），不接管/关闭该浏览器
  --connect-over-cdp <url> --cdp-url 的别名
  --delay-min <ms>        API 请求最小间隔，默认 2500
  --delay-max <ms>        API 请求最大间隔，默认 4000
  --timeout <ms>          页面/API 超时，默认 30000
  --verification-timeout <ms> 人工验证等待上限，默认 600000
  --verification-probe-interval <ms> API 验证探测间隔，默认 5000
  --no-download-assets    只记录素材 URL，不下载
  --no-save-raw           不保存 gzip API 原始快照
  --no-resume             不复用/克隆未完成运行
  --resume-run-id <id>    从指定的已封存不完整运行续采
  --db <path>             SQLite，默认 data/zujuan.sqlite3
  --data-dir <path>       快照与素材目录，默认 data/zujuan-question-sync
  --profile-dir <path>    固定 persistent profile，默认 .cache/zujuan-sync-profile
  --fallback-profile-dir <path>  兼容旧参数，风控时不再使用预登录档案
  --status                只显示 collector 状态
  --help                  显示帮助

安全行为：题目列表默认 8 路并发，部署节奏以运维配置为准。限流/验证会持久暂停同来源，保留成功页和断点；验证需要人工核对后恢复，不通过切换会话继续。教材发现、内容、素材和重试共用每日主动请求预算。
`;
}

function parseArgs(argv = []) {
  const cwd = process.cwd();
  const projectRoot = path.resolve(__dirname, '..', '..');
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    treeBaseUrl: 'https://static.zxxk.com',
    apiPath: DEFAULT_API_PATH,
    bankId: DEFAULT_BANK_ID,
    bankPath: DEFAULT_BANK_PATH,
    textbookId: DEFAULT_TEXTBOOK_ID,
    chapterId: null,
    catalogIds: [],
    catalogLevels: [],
    maxCatalogs: 0,
    startPage: 1,
    maxPages: SITE_PAGE_LIMIT,
    maxPagesProvided: false,
    limitTo1000Pages: false,
    catalogPageLimit: null,
    safetyPageLimit: DEFAULT_PAGINATION_SAFETY_LIMIT,
    limit: 0,
    headless: false,
    cdpUrl: null,
    delayMin: DEFAULT_DELAY_MIN,
    delayMax: DEFAULT_DELAY_MAX,
    timeout: DEFAULT_TIMEOUT,
    verificationTimeout: DEFAULT_VERIFICATION_TIMEOUT,
    verificationPoll: DEFAULT_VERIFICATION_POLL,
    verificationProbeInterval: DEFAULT_VERIFICATION_PROBE_INTERVAL,
    downloadAssets: true,
    saveRaw: true,
    resume: true,
    resumeRunId: null,
    dbPath: path.resolve(projectRoot, 'data/zujuan.sqlite3'),
    dataDir: path.resolve(projectRoot, 'data/zujuan-question-sync'),
    profileDir: path.resolve(projectRoot, '.cache/zujuan-sync-profile'),
    fallbackProfileDirs: [],
    concurrency: DEFAULT_LIST_CONCURRENCY,
    assetConcurrency: DEFAULT_ASSET_CONCURRENCY,
    eventsStdout: false,
    statusOnly: false,
    help: false,
  };
  const needValue = (index, flag) => {
    if (index + 1 >= argv.length || String(argv[index + 1]).startsWith('--')) throw new Error(`${flag} 缺少参数值。`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--textbook-id':
        options.textbookId = String(needValue(index, flag));
        index += 1;
        break;
      case '--chapter-id':
        options.chapterId = String(needValue(index, flag));
        index += 1;
        break;
      case '--bank-id':
        options.bankId = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      case '--bank-path':
        options.bankPath = String(needValue(index, flag)).trim();
        index += 1;
        break;
      case '--catalog-id':
        options.catalogIds.push(String(needValue(index, flag)));
        index += 1;
        break;
      case '--catalog-level': {
        const level = parsePositiveInt(needValue(index, flag), flag);
        if (![1, 2, 3].includes(level)) throw new Error('--catalog-level 只能是 1、2、3。');
        options.catalogLevels.push(level);
        index += 1;
        break;
      }
      case '--max-catalogs':
        options.maxCatalogs = parsePositiveInt(needValue(index, flag), flag, { allowZero: true });
        index += 1;
        break;
      case '--start-page':
        options.startPage = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      case '--max-pages':
        options.maxPages = parsePositiveInt(needValue(index, flag), flag);
        options.maxPagesProvided = true;
        index += 1;
        break;
      case '--limit-to-1000-pages':
        options.limitTo1000Pages = true;
        break;
      case '--catalog-page-limit':
        options.catalogPageLimit = parsePositiveInt(needValue(index, flag), flag);
        if (options.catalogPageLimit > DEFAULT_PAGINATION_SAFETY_LIMIT)
          throw new Error('--catalog-page-limit 必须为 1 到 10000 的整数');
        index += 1;
        break;
      case '--safety-page-limit':
        options.safetyPageLimit = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      case '--limit':
        options.limit = parsePositiveInt(needValue(index, flag), flag, { allowZero: true });
        index += 1;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--headful':
        options.headless = false;
        break;
      case '--cdp-url':
      case '--connect-over-cdp':
        options.cdpUrl = String(needValue(index, flag)).trim();
        index += 1;
        break;
      case '--delay-min':
        options.delayMin = parsePositiveInt(needValue(index, flag), flag, { allowZero: true });
        index += 1;
        break;
      case '--delay-max':
        options.delayMax = parsePositiveInt(needValue(index, flag), flag, { allowZero: true });
        index += 1;
        break;
      case '--timeout':
        options.timeout = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      case '--verification-timeout':
        options.verificationTimeout = parsePositiveInt(needValue(index, flag), flag, { allowZero: true });
        index += 1;
        break;
      case '--verification-poll':
        options.verificationPoll = parsePositiveInt(needValue(index, flag), flag, { allowZero: true });
        index += 1;
        break;
      case '--verification-probe-interval':
        options.verificationProbeInterval = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      case '--no-download-assets':
        options.downloadAssets = false;
        break;
      case '--download-assets':
        options.downloadAssets = true;
        break;
      case '--no-save-raw':
        options.saveRaw = false;
        break;
      case '--no-resume':
        options.resume = false;
        break;
      case '--resume-run-id':
        options.resumeRunId = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      // The HTTP collector already enforces this acknowledgement before it
      // starts a child.  Accept the established CLI flag so the new script
      // can be selected without widening the server request contract.
      case '--acknowledge-source-policy':
        break;
      case '--db':
        options.dbPath = path.resolve(cwd, needValue(index, flag));
        index += 1;
        break;
      case '--data-dir':
        options.dataDir = path.resolve(cwd, needValue(index, flag));
        index += 1;
        break;
      case '--profile-dir':
        options.profileDir = path.resolve(cwd, needValue(index, flag));
        index += 1;
        break;
      case '--fallback-profile-dir':
        options.fallbackProfileDirs.push(path.resolve(cwd, needValue(index, flag)));
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      case '--asset-concurrency':
        options.assetConcurrency = parsePositiveInt(needValue(index, flag), flag);
        index += 1;
        break;
      // Diagnostic only: mirror structured job events to stdout as
      // `@@event {json}` lines.  The API manager uses the IPC channel.
      case '--events-stdout':
        options.eventsStdout = true;
        break;
      case '--status':
        options.statusOnly = true;
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }
  if (!options.textbookId.trim()) throw new Error('--textbook-id 不能为空。');
  options.chapterId = String(options.chapterId || options.textbookId).trim();
  if (!options.chapterId) throw new Error('--chapter-id 不能为空。');
  if (!options.bankPath.trim()) throw new Error('--bank-path 不能为空。');
  options.sourceNamespace = assertMathSource(options);
  if (options.cdpUrl) {
    let parsedCdp;
    try {
      parsedCdp = new URL(options.cdpUrl);
    } catch {
      throw new Error('--cdp-url 必须是有效的 CDP URL。');
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsedCdp.protocol)) {
      throw new Error('--cdp-url 只支持 http(s)/ws(s) URL。');
    }
  }
  if (options.delayMax < options.delayMin) throw new Error('--delay-max 不能小于 --delay-min。');
  if (options.maxPages > catalogSafetyPageLimit(options)) {
    throw new Error(`--max-pages 不能超过安全上限 ${catalogSafetyPageLimit(options)}。`);
  }
  if (options.concurrency > MAX_LIST_CONCURRENCY) {
    throw new Error(`--concurrency 不能超过 ${MAX_LIST_CONCURRENCY}。`);
  }
  if (options.assetConcurrency > MAX_ASSET_CONCURRENCY) {
    throw new Error(`--asset-concurrency 不能超过 ${MAX_ASSET_CONCURRENCY}。`);
  }
  if (!options.resume && options.resumeRunId != null) {
    throw new Error('--resume-run-id 不能与 --no-resume 同时使用。');
  }
  options.catalogIds = [...new Set(options.catalogIds.map((value) => value.trim()).filter(Boolean))];
  options.catalogLevels = [...new Set(options.catalogLevels)].sort();
  const primaryProfile = path.resolve(options.profileDir);
  options.fallbackProfileDirs = [...new Set(options.fallbackProfileDirs.map((dir) => path.resolve(dir)))].filter(
    (dir) => dir !== primaryProfile,
  );
  return options;
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
      const store = new QuestionSyncStore(options.dbPath, { dataDir: options.dataDir });
      try {
        console.log(JSON.stringify(store.status(), null, 2));
      } finally {
        store.close();
      }
      return;
    }
    await runSync(options);
  } catch (error) {
    if (!error?.eventEmitted) {
      createProcessEventEmitter({ stdout: options?.eventsStdout === true }).emit('error', {
        code: error?.code || error?.name || 'cli_error',
        message: String(error?.message || error),
        recoverable: false,
        stage: 'cli',
      });
    }
    console.error(`\n[错误] ${error.message}`);
    if (!options?.help) console.error('使用 --help 查看参数。');
    process.exitCode = 1;
  }
  return options;
}

function runCli() {
  // A connected-over-CDP Playwright transport may keep a socket/event loop
  // handle after its dedicated tab is closed.  This is CLI-only cleanup:
  // all run finally blocks have completed, and we deliberately do not call
  // browser.close() because that browser belongs to the operator.
  return main().then((options) => {
    // Owned browsers have been closed; let IPC/stdout drain and libuv reap
    // children naturally. Only an external CDP transport needs forced exit.
    if (process.connected) process.disconnect();
    if (options?.cdpUrl) process.exit(process.exitCode || 0);
  });
}

module.exports = {
  main,
  parseArgs,
  runCli,
  usage,
};
