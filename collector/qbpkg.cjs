#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildPackage, QbPkgValidationError } = require('./src/qbpkg/builder.cjs');
const { verifyPackage } = require('./src/qbpkg/validator.cjs');

function usage() {
  return `
qbpkg 离线发布包构建与验证工具

用法：
  node qbpkg.cjs build --db <采集库> --output <包.qbpkg> \
    --metadata <JSON或文件> --full-snapshot --range-evidence <JSON或文件>
  node qbpkg.cjs verify --package <包.qbpkg>

build 必需参数：
  --db <path>                采集 SQLite 路径
  --output <path>            不存在的 qbpkg 输出路径（默认拒绝覆盖）
  --metadata <json|path>     显式 dataset metadata，至少 provider/versionName/textbookName/
                             versionExternalId/textbookExternalId；册次使用 volume
  --full-snapshot            显式声明本次是完整快照
  --range-evidence <json|path> 同步范围与完成证据，须声明已完成

build 可选参数：
  --previous <path>          上一 qbpkg 或 snapshot.sqlite3，用于 diff
  --batch-no <value>         固定批次号
  --created-at <ISO>         固定创建时间，便于可复现包
  --decrease-threshold <n>   章节下降超过该数值时阻断
  --block-on-deactivation    发现停用题目时阻断
  --help                     显示帮助

verify 可选参数：
  --package <path>           qbpkg 路径
  --help                     显示帮助
`;
}

function value(args, index, name) {
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return args[index + 1];
}

function parseJsonOrFile(input, label) {
  if (input == null) return null;
  const raw = String(input);
  try {
    if (fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, 'utf8'));
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON 或文件：${error.message}`);
  }
}

function parseArgs(argv) {
  const options = { command: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!options.command && !arg.startsWith('--')) {
      options.command = arg;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    switch (arg) {
      case '--db':
      case '--source-db':
      case '--source':
        options.db = value(argv, i, arg);
        i += 1;
        break;
      case '--output':
      case '--out':
        options.output = value(argv, i, arg);
        i += 1;
        break;
      case '--package':
      case '--package-path':
        options.package = value(argv, i, arg);
        i += 1;
        break;
      case '--metadata':
      case '--metadata-json':
      case '--dataset':
      case '--dataset-metadata':
        options.metadata = parseJsonOrFile(value(argv, i, arg), 'metadata');
        i += 1;
        break;
      case '--range-evidence':
      case '--completion-evidence':
      case '--sync-range':
        options.rangeEvidence = parseJsonOrFile(value(argv, i, arg), 'range evidence');
        i += 1;
        break;
      case '--provider':
        options.metadata = { ...(options.metadata || {}), provider: value(argv, i, arg) };
        i += 1;
        break;
      case '--version-name':
        options.metadata = { ...(options.metadata || {}), versionName: value(argv, i, arg) };
        i += 1;
        break;
      case '--textbook-name':
        options.metadata = { ...(options.metadata || {}), textbookName: value(argv, i, arg) };
        i += 1;
        break;
      case '--previous':
        options.previous = value(argv, i, arg);
        i += 1;
        break;
      case '--batch-no':
        options.batchNo = value(argv, i, arg);
        i += 1;
        break;
      case '--created-at':
        options.createdAt = value(argv, i, arg);
        i += 1;
        break;
      case '--decrease-threshold':
      case '--max-decrease':
        options.decreaseThreshold = Number(value(argv, i, arg));
        i += 1;
        break;
      case '--block-on-deactivation':
        options.blockOnDeactivation = true;
        break;
      case '--include-visible-solutions':
      case '--public-solutions':
        options.includeVisibleSolutions = true;
        break;
      case '--full-snapshot':
        options.fullSnapshot = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.help && !options.command) throw new Error('缺少 build 或 verify 子命令');
  if (!options.help && !['build', 'verify'].includes(options.command))
    throw new Error(`未知子命令：${options.command}`);
  if (!options.help && options.command === 'build') {
    for (const field of ['db', 'output', 'metadata', 'rangeEvidence'])
      if (options[field] == null)
        throw new Error(`build 缺少 --${field === 'rangeEvidence' ? 'range-evidence' : field}`);
    if (options.fullSnapshot !== true) throw new Error('build 必须显式提供 --full-snapshot');
  }
  if (!options.help && options.command === 'verify' && !options.package) throw new Error('verify 缺少 --package');
  if (positional.length > 0) throw new Error(`多余位置参数：${positional.join(' ')}`);
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    if (options.command === 'build') {
      const result = buildPackage(options);
      console.log(
        JSON.stringify(
          { output: result.outputPath, manifest: result.manifest, diff: result.diff, validation: result.validation },
          null,
          2,
        ),
      );
      return 0;
    }
    const report = verifyPackage(options.package, { throwOnError: false });
    console.log(JSON.stringify(report, null, 2));
    return report.pass ? 0 : 1;
  } catch (error) {
    if (error instanceof QbPkgValidationError && error.report) console.error(JSON.stringify(error.report, null, 2));
    else console.error(`[错误] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, usage };
