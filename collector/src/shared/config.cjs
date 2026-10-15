'use strict';

/**
 * One place that knows every COLLECTOR_* deployment setting.
 *
 * The modules that consume a setting still read it themselves (constructor
 * option first, then the environment), so tests and direct callers keep
 * working.  This registry adds what was missing:
 *
 *   - validateConfig(env): the API checks every setting at startup, so a bad
 *     value fails the container immediately instead of failing a crawl child
 *     hours later, and an unknown COLLECTOR_* name (a typo) is reported.
 *   - describeConfig(): the effective values, printed once at startup and
 *     served by GET /v1/config, with secrets redacted.
 *
 * Keep defaults here equal to the defaults in the consuming module; the
 * config test asserts the two agree for the settings that have one.
 */

const SETTINGS = [
  // API process
  { name: 'COLLECTOR_API_HOST', kind: 'string', fallback: '127.0.0.1', scope: 'api', doc: 'HTTP 监听地址' },
  { name: 'COLLECTOR_API_PORT', kind: 'int', fallback: 9110, min: 1, max: 65535, scope: 'api', doc: 'HTTP 端口' },
  {
    name: 'COLLECTOR_API_TOKEN',
    kind: 'string',
    fallback: '',
    secret: true,
    scope: 'api',
    doc: 'Bearer 认证令牌；非本机监听时必填',
  },
  { name: 'COLLECTOR_DB', kind: 'path', fallback: null, scope: 'api', doc: '采集 SQLite 路径' },
  { name: 'COLLECTOR_DATA_DIR', kind: 'path', fallback: null, scope: 'api', doc: '素材与原始页目录' },
  { name: 'COLLECTOR_PROFILE_DIR', kind: 'path', fallback: null, scope: 'api', doc: 'Chrome 持久化 profile 目录' },
  { name: 'COLLECTOR_NODE_BIN', kind: 'path', fallback: null, scope: 'api', doc: '启动采集子进程的 node' },
  { name: 'COLLECTOR_HEADFUL', kind: 'bool', fallback: true, scope: 'api', doc: '有头 Chrome' },
  {
    name: 'COLLECTOR_JOB_TIMEOUT_MS',
    kind: 'int',
    fallback: 24 * 60 * 60 * 1000,
    min: 1,
    scope: 'api',
    doc: '单个任务总时限',
  },
  {
    name: 'COLLECTOR_STALL_TIMEOUT_MS',
    kind: 'int',
    fallback: 20 * 60 * 1000,
    min: 1,
    scope: 'api',
    doc: '无心跳判定卡死',
  },
  {
    name: 'COLLECTOR_CHILD_MAX_RSS_MB',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'api',
    doc: '子进程 RSS 上限，0 关闭',
  },
  {
    name: 'COLLECTOR_PERSIST_INTERVAL_MS',
    kind: 'int',
    fallback: 5000,
    min: 1,
    scope: 'api',
    doc: '任务进度落库合并间隔',
  },
  {
    name: 'COLLECTOR_READER_THREADS',
    kind: 'int',
    fallback: 2,
    min: 0,
    max: 8,
    scope: 'api',
    doc: 'API 读取线程数，0 为主线程读取',
  },
  {
    name: 'COLLECTOR_READER_TIMEOUT_MS',
    kind: 'int',
    fallback: 25000,
    min: 1000,
    max: 600000,
    scope: 'api',
    doc: '读取总时限（含排队），超时返回 504；需小于 Service 的 30 秒请求超时',
  },
  // Crawl pacing (passed to the child as CLI flags)
  {
    name: 'COLLECTOR_LIST_CONCURRENCY',
    kind: 'int',
    fallback: null,
    min: 1,
    max: 16,
    scope: 'crawl',
    doc: '列表分页并发',
  },
  {
    name: 'COLLECTOR_ASSET_CONCURRENCY',
    kind: 'int',
    fallback: null,
    min: 1,
    max: 32,
    scope: 'crawl',
    doc: '素材下载并发',
  },
  {
    name: 'COLLECTOR_DELAY_MIN_MS',
    kind: 'int',
    fallback: null,
    min: 0,
    max: 600000,
    scope: 'crawl',
    doc: '请求最小间隔',
  },
  {
    name: 'COLLECTOR_DELAY_MAX_MS',
    kind: 'int',
    fallback: null,
    min: 0,
    max: 600000,
    scope: 'crawl',
    doc: '请求最大间隔',
  },
  // Resource guard
  { name: 'COLLECTOR_MIN_DISK_FREE_MIB', kind: 'int', fallback: 0, min: 0, scope: 'resources', doc: '磁盘保留水位' },
  { name: 'COLLECTOR_MIN_MEMORY_FREE_MIB', kind: 'int', fallback: 0, min: 0, scope: 'resources', doc: '内存硬水位' },
  {
    name: 'COLLECTOR_SOFT_MEMORY_FREE_MIB',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'resources',
    doc: '内存软水位（触发浏览器回收）',
  },
  {
    name: 'COLLECTOR_MEMORY_GRACE_MS',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'resources',
    doc: '低于硬水位持续多久才停止',
  },
  // Browser recycling (read by the crawl child)
  {
    name: 'COLLECTOR_CLOSED_CONTEXT_RECOVERIES',
    kind: 'int',
    fallback: 2,
    min: 0,
    scope: 'browser',
    doc: '浏览器上下文意外关闭后，本次运行内最多自动重建几次，0 关闭',
  },
  {
    name: 'COLLECTOR_BROWSER_RECYCLE_PAGES',
    kind: 'int',
    fallback: 400,
    min: 0,
    scope: 'browser',
    doc: '每采集多少页回收浏览器，0 关闭',
  },
  {
    name: 'COLLECTOR_BROWSER_RECYCLE_MB',
    kind: 'int',
    fallback: 1000,
    min: 0,
    scope: 'browser',
    doc: 'Chrome 超过多少 MB 回收，0 关闭',
  },
  {
    name: 'COLLECTOR_BROWSER_PRESSURE_MIN_PAGES',
    kind: 'int',
    fallback: 40,
    min: 0,
    scope: 'browser',
    doc: '软水位回收的最小页数间隔',
  },
  // Daily source budget
  {
    name: 'COLLECTOR_SOURCE_DAILY_REQUEST_LIMIT',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'budget',
    doc: '每日请求数，0 不限',
  },
  {
    name: 'COLLECTOR_SOURCE_DAILY_BOOK_LIMIT',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'budget',
    doc: '每日教材数，0 不限',
  },
  {
    name: 'COLLECTOR_SOURCE_DAILY_ACTIVE_SECONDS',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'budget',
    doc: '每日采集时长，0 不限',
  },
  {
    name: 'COLLECTOR_SOURCE_DAILY_DOWNLOAD_MIB',
    kind: 'int',
    fallback: 0,
    min: 0,
    scope: 'budget',
    doc: '每日下载量，0 不限',
  },
  // Debugging
  {
    name: 'COLLECTOR_DIAGNOSTICS_DIR',
    kind: 'path',
    fallback: null,
    scope: 'debug',
    doc: '事件日志目录，默认使用 COLLECTOR_DATA_DIR/diagnostics',
  },
  {
    name: 'COLLECTOR_DIAGNOSTICS_RETENTION_DAYS',
    kind: 'int',
    fallback: 7,
    min: 0,
    scope: 'debug',
    doc: '诊断日志保留天数，0 不自动删除',
  },
  {
    name: 'COLLECTOR_RAW_RETENTION_DAYS',
    kind: 'int',
    fallback: 3,
    min: 0,
    scope: 'debug',
    doc: '原始页面保留天数；只删除已回收或干净封存运行的原始页，0 不自动删除',
  },
  {
    name: 'COLLECTOR_DIAGNOSTIC_JOB_ID',
    kind: 'string',
    fallback: '',
    scope: 'debug',
    doc: '管理器传给采集子进程的日志关联任务 ID',
  },
  {
    name: 'COLLECTOR_EVENT_CHANNEL',
    kind: 'enum',
    values: ['', 'ipc', 'stdout', 'none'],
    fallback: '',
    scope: 'debug',
    doc: '子进程事件通道',
  },
];

const BY_NAME = new Map(SETTINGS.map((setting) => [setting.name, setting]));
const BOOL_TRUE = new Set(['1', 'true', 'yes', 'y', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'n', 'off']);

function parseSetting(setting, raw) {
  if (raw == null || raw === '') return { value: setting.fallback };
  const text = String(raw).trim();
  switch (setting.kind) {
    case 'int': {
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
        return { error: `${setting.name} 必须是整数，当前为 ${JSON.stringify(text)}` };
      }
      const value = Number(text);
      if (setting.min != null && value < setting.min) return { error: `${setting.name} 不能小于 ${setting.min}` };
      if (setting.max != null && value > setting.max) return { error: `${setting.name} 不能大于 ${setting.max}` };
      return { value };
    }
    case 'bool': {
      const lowered = text.toLowerCase();
      if (BOOL_TRUE.has(lowered)) return { value: true };
      if (BOOL_FALSE.has(lowered)) return { value: false };
      return { error: `${setting.name} 必须是 true 或 false` };
    }
    case 'enum': {
      const lowered = text.toLowerCase();
      if (!setting.values.includes(lowered))
        return { error: `${setting.name} 只能是 ${setting.values.filter(Boolean).join(' / ')}` };
      return { value: lowered };
    }
    default:
      return { value: text };
  }
}

/**
 * Parse and check every known COLLECTOR_* setting in `env`.
 * Returns { values, errors, warnings, unknown }; `values` holds the parsed value (or
 * the fallback) for every setting, keyed by env name.
 */
function validateConfig(env = process.env) {
  const values = {};
  const errors = [];
  const warnings = [];
  for (const setting of SETTINGS) {
    const parsed = parseSetting(setting, env[setting.name]);
    if (parsed.error) errors.push(parsed.error);
    else values[setting.name] = parsed.value;
  }
  const min = values.COLLECTOR_DELAY_MIN_MS;
  const max = values.COLLECTOR_DELAY_MAX_MS;
  if (min != null && max != null && max < min) errors.push('COLLECTOR_DELAY_MAX_MS 不能小于 COLLECTOR_DELAY_MIN_MS');
  const soft = values.COLLECTOR_SOFT_MEMORY_FREE_MIB;
  const hard = values.COLLECTOR_MIN_MEMORY_FREE_MIB;
  if (soft > 0 && hard > 0 && soft < hard) {
    warnings.push('COLLECTOR_SOFT_MEMORY_FREE_MIB 小于 COLLECTOR_MIN_MEMORY_FREE_MIB，软水位不会先于硬水位触发');
  }
  const unknown = Object.keys(env)
    .filter((name) => name.startsWith('COLLECTOR_') && !BY_NAME.has(name))
    .sort();
  for (const name of unknown) warnings.push(`未知变量 ${name}，已忽略（拼写错误？）`);
  return { values, errors, warnings, unknown };
}

/**
 * Effective settings with secrets redacted, grouped by scope.  `redactPaths`
 * hides filesystem paths too (the HTTP projection never exposes host paths).
 */
function describeConfig(values, { redactPaths = false } = {}) {
  const groups = {};
  for (const setting of SETTINGS) {
    let value = values[setting.name];
    if (setting.secret) value = value ? '***' : '';
    else if (redactPaths && setting.kind === 'path') value = value ? '（已配置）' : null;
    (groups[setting.scope] ||= {})[setting.name] = value;
  }
  return groups;
}

function formatConfig(values) {
  return Object.entries(describeConfig(values))
    .map(
      ([scope, entries]) =>
        `  [${scope}] ${Object.entries(entries)
          .map(([name, value]) => `${name.replace(/^COLLECTOR_/, '')}=${value == null ? '默认' : value}`)
          .join(' ')}`,
    )
    .join('\n');
}

module.exports = {
  SETTINGS,
  describeConfig,
  formatConfig,
  parseSetting,
  validateConfig,
};
