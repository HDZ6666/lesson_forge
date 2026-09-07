#!/usr/bin/env node
'use strict';

/**
 * Static check used by the split plan: report identifiers that are read in a
 * module but neither declared in it nor Node/JS globals.  `node --check` only
 * validates syntax; moving code between files typically breaks references,
 * not syntax.
 *
 *   node tests/tools/scan_undeclared.cjs [file ...]
 *
 * Defaults to every .cjs under src/, lib/ and the root entry scripts.  Uses
 * pc/node_modules/acorn (dev-only, not a collector dependency); exits 2 when
 * the parser is unavailable so CI can distinguish "skipped" from "clean".
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ACORN_PATH = path.resolve(ROOT, '..', 'pc', 'node_modules', 'acorn');

let acorn;
try {
  acorn = require(ACORN_PATH);
} catch {
  console.error(`acorn 不可用（${ACORN_PATH}），跳过未声明标识符扫描`);
  process.exit(2);
}

const GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', 'Buffer',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Math', 'JSON', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'BigInt', 'Reflect', 'Proxy',
  'Intl', 'Infinity', 'NaN', 'undefined', 'globalThis', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly', 'performance',
  'arguments', 'eval', 'Function', 'document', 'window', 'location', 'navigator', 'crypto',
]);

function collectFiles(args) {
  if (args.length) return args.map((item) => path.resolve(item));
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'qbpkg') continue;
        walk(full);
      } else if (entry.name.endsWith('.cjs')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'lib'));
  for (const name of ['server.cjs', 'zujuan_question_sync.cjs', 'zujuan_metadata_sync.cjs', 'zujuan_sync.cjs']) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) out.push(full);
  }
  return out;
}

function declaredNames(pattern, into) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': into.add(pattern.name); break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) declaredNames(prop.type === 'RestElement' ? prop.argument : prop.value, into);
      break;
    case 'ArrayPattern': for (const element of pattern.elements) declaredNames(element, into); break;
    case 'RestElement': declaredNames(pattern.argument, into); break;
    case 'AssignmentPattern': declaredNames(pattern.left, into); break;
    default: break;
  }
}

function scan(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
  const problems = [];
  const scopes = [new Set()];
  const declare = (name) => scopes[scopes.length - 1].add(name);
  const has = (name) => scopes.some((scope) => scope.has(name)) || GLOBALS.has(name);

  function hoist(body) {
    for (const node of body || []) {
      if (node.type === 'FunctionDeclaration' && node.id) declare(node.id.name);
      if (node.type === 'ClassDeclaration' && node.id) declare(node.id.name);
      if (node.type === 'VariableDeclaration') for (const decl of node.declarations) declaredNames(decl.id, scopes[scopes.length - 1]);
    }
  }

  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Program':
        hoist(node.body);
        for (const child of node.body) visit(child, node);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        scopes.push(new Set());
        if (node.type === 'FunctionExpression' && node.id) declare(node.id.name);
        for (const param of node.params) declaredNames(param, scopes[scopes.length - 1]);
        if (node.body.type === 'BlockStatement') {
          hoist(node.body.body);
          for (const child of node.body.body) visit(child, node.body);
        } else {
          visit(node.body, node);
        }
        for (const param of node.params) visitDefaults(param);
        scopes.pop();
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.type === 'ClassExpression' && node.id) declare(node.id.name);
        if (node.superClass) visit(node.superClass, node);
        for (const member of node.body.body) {
          if (member.computed) visit(member.key, member);
          if (member.value) visit(member.value, member);
        }
        return;
      case 'BlockStatement':
      case 'StaticBlock':
        scopes.push(new Set());
        hoist(node.body);
        for (const child of node.body) visit(child, node);
        scopes.pop();
        return;
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        scopes.push(new Set());
        const init = node.init || node.left;
        if (init && init.type === 'VariableDeclaration') {
          for (const decl of init.declarations) declaredNames(decl.id, scopes[scopes.length - 1]);
        }
        for (const key of ['init', 'left', 'right', 'test', 'update', 'body']) if (node[key]) visit(node[key], node);
        scopes.pop();
        return;
      }
      case 'CatchClause':
        scopes.push(new Set());
        if (node.param) declaredNames(node.param, scopes[scopes.length - 1]);
        visit(node.body, node);
        scopes.pop();
        return;
      case 'SwitchStatement':
        visit(node.discriminant, node);
        scopes.push(new Set());
        for (const kase of node.cases) hoist(kase.consequent);
        for (const kase of node.cases) {
          if (kase.test) visit(kase.test, kase);
          for (const child of kase.consequent) visit(child, kase);
        }
        scopes.pop();
        return;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          declaredNames(decl.id, scopes[scopes.length - 1]);
          if (decl.init) visit(decl.init, decl);
          visitDefaults(decl.id);
        }
        return;
      case 'Identifier':
        if (!has(node.name)) {
          problems.push(`${path.relative(ROOT, file)}:${node.loc.start.line}:${node.loc.start.column + 1} 未声明标识符 ${node.name}`);
        }
        return;
      case 'MemberExpression':
        visit(node.object, node);
        if (node.computed) visit(node.property, node);
        return;
      case 'Property':
        if (node.computed) visit(node.key, node);
        if (node.shorthand && node.value.type === 'Identifier') { visit(node.value, node); return; }
        visit(node.value, node);
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, node);
        if (node.value) visit(node.value, node);
        return;
      case 'LabeledStatement':
        visit(node.body, node);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      case 'MetaProperty':
        return;
      default:
        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
          const value = node[key];
          if (Array.isArray(value)) {
            for (const child of value) {
              if (child && typeof child.type === 'string') visit(child, node);
            }
          } else if (value && typeof value.type === 'string') {
            visit(value, node);
          }
        }
    }
  }

  function visitDefaults(pattern) {
    if (!pattern) return;
    if (pattern.type === 'AssignmentPattern') { visit(pattern.right, pattern); visitDefaults(pattern.left); }
    else if (pattern.type === 'ObjectPattern') for (const prop of pattern.properties) visitDefaults(prop.type === 'RestElement' ? prop.argument : prop.value);
    else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) visitDefaults(element);
  }

  visit(ast, null);
  return problems;
}

const files = collectFiles(process.argv.slice(2));
let total = 0;
for (const file of files) {
  try {
    const problems = scan(file);
    total += problems.length;
    for (const problem of problems) console.log(problem);
  } catch (error) {
    total += 1;
    console.log(`${path.relative(ROOT, file)}: 解析失败 ${error.message}`);
  }
}
console.log(total ? `发现 ${total} 处问题（扫描 ${files.length} 个文件）` : `扫描 ${files.length} 个文件，无未声明标识符`);
process.exit(total ? 1 : 0);
