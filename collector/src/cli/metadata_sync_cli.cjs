'use strict';

/**
 * CLI surface of the metadata (version / textbook) discovery collector.
 * Flags and help text are unchanged; `--events-stdout` is a hidden diagnostic.
 */

const path = require('node:path');
const process = require('node:process');

const { parsePositiveInt } = require('../shared/utils.cjs');
const { ALLOWED_PAGE_HOSTS } = require('../shared/url_policy.cjs');
const { DEFAULT_BASE_URL, DEFAULT_SEED_URL } = require('../sources/zujuan/constants.cjs');
const { MetadataStore, buildReport, formatReport, writeJsonOutput } = require('../storage/metadata_store.cjs');
const { createProcessEventEmitter } = require('../jobs/events.cjs');
const { runDiscovery } = require('../jobs/metadata_run.cjs');

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
  const projectRoot = path.resolve(__dirname, '..', '..');
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
      // Diagnostic only: mirror structured job events to stdout.
      case '--events-stdout':
        options.eventsStdout = true;
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
}

module.exports = {
  main,
  parseArgs,
  printStatus,
  usage,
};
