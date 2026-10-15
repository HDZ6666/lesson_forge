'use strict';

const { sha256 } = require('./util.cjs');

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const BLOCKED_TAGS = new Set([
  'base',
  'button',
  'embed',
  'form',
  'iframe',
  'input',
  'link',
  'meta',
  'object',
  'script',
  'select',
  'style',
  'textarea',
]);

const URL_ATTRIBUTE_PATTERN = /\b(?:href|src|action|formaction|poster|xlink:href)\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/gi;
const EVENT_ATTRIBUTE_PATTERN = /\s(on[a-z0-9_-]+)\s*=/i;
const ACTIVE_CONTENT_URL_PATTERN = /^\s*(?:javascript|vbscript|data)\s*:/i;

function sanitizeHtml(value) {
  if (value == null || value === '') return value == null ? null : String(value);
  let html = String(value);
  html = html.replace(/<(script|style|iframe|object|embed|form|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(
    /<\/?(?:base|button|embed|form|iframe|input|link|meta|object|script|select|style|textarea)\b[^>]*>/gi,
    '',
  );
  html = html.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s+(?:style|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(
    /\s+(href|src|action|formaction|poster|xlink:href)\s*=\s*(?:(['"])(.*?)\2|([^\s>]+))/gi,
    (match, _name, _quote, quotedUrl, bareUrl) =>
      ACTIVE_CONTENT_URL_PATTERN.test(quotedUrl ?? bareUrl ?? '') ? '' : match,
  );
  return html;
}

function checkHtml(value) {
  if (value == null || value === '') return { valid: true, errors: [] };
  const html = String(value);
  const errors = [];
  const stack = [];
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const endComment = html.indexOf('-->', start + 4);
      if (endComment < 0) errors.push('未闭合 HTML 注释');
      else index = endComment + 3;
      continue;
    }
    const end = html.indexOf('>', start + 1);
    if (end < 0) {
      errors.push('标签缺少 >');
      break;
    }
    const token = html.slice(start + 1, end).trim();
    if (!token || token.startsWith('!') || token.startsWith('?')) {
      index = end + 1;
      continue;
    }
    const close = token.startsWith('/');
    const selfClosing = /\/\s*$/.test(token);
    const nameMatch = token.match(/^\/?\s*([A-Za-z][\w:-]*)/);
    if (!nameMatch) {
      errors.push(`非法标签：<${token.slice(0, 40)}> `);
      index = end + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    if (close) {
      if (stack.length === 0 || stack[stack.length - 1] !== name) {
        errors.push(`标签闭合顺序错误：${name}`);
      } else stack.pop();
    } else if (!selfClosing && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
    index = end + 1;
  }
  if (stack.length) errors.push(`未闭合标签：${stack.join(',')}`);
  return { valid: errors.length === 0, errors };
}

function checkHtmlSafety(value) {
  if (value == null || value === '') return { valid: true, errors: [] };
  const html = String(value);
  const errors = [];
  const tags = html.match(/<[^>]+>/g) || [];

  for (const tag of tags) {
    const name = tag.match(/^<\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
    if (name && BLOCKED_TAGS.has(name)) errors.push(`不允许的 HTML 标签：${name}`);
    const eventAttribute = tag.match(EVENT_ATTRIBUTE_PATTERN)?.[1];
    if (eventAttribute) errors.push(`不允许的事件属性：${eventAttribute.toLowerCase()}`);
    if (/\s(?:style|srcdoc)\s*=/i.test(tag)) errors.push('不允许 style 或 srcdoc 属性');

    URL_ATTRIBUTE_PATTERN.lastIndex = 0;
    for (const match of tag.matchAll(URL_ATTRIBUTE_PATTERN)) {
      const url = match[2] ?? match[3] ?? '';
      if (ACTIVE_CONTENT_URL_PATTERN.test(url)) errors.push(`不允许的主动内容 URL：${url.slice(0, 80)}`);
    }
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function assetKey(assetType, sourceUrl) {
  const type =
    String(assetType || 'asset')
      .trim()
      .toLowerCase() || 'asset';
  return `${type}-${sha256(String(sourceUrl)).slice(0, 16)}`;
}

function replaceImageSources(html, assetsByUrl) {
  if (html == null || html === '') return { html: html == null ? null : String(html), missing: [] };
  const missing = [];
  const input = String(html);
  const output = input
    .replace(
      /<img\b([^>]*?)\bsrc(\s*=\s*)(["'])([\s\S]*?)\3([^>]*)>/gi,
      (match, before, equals, quote, sourceUrl, after) => {
        const asset = assetsByUrl.get(sourceUrl);
        if (!asset) {
          missing.push(sourceUrl);
          return match;
        }
        return `<img${before}data-asset-key${equals}${quote}${asset.assetKey}${quote}${after}>`;
      },
    )
    .replace(/<img\b([^>]*?)\bsrc(\s*=\s*)(?!["'])([^\s>]+)([^>]*)>/gi, (match, before, equals, sourceUrl, after) => {
      const asset = assetsByUrl.get(sourceUrl);
      if (!asset) {
        missing.push(sourceUrl);
        return match;
      }
      return `<img${before}data-asset-key${equals}${asset.assetKey}${after}>`;
    });
  return { html: output, missing };
}

function normalizeHtml(html, assetsByUrl) {
  const sanitized = sanitizeHtml(html);
  const before = checkHtml(sanitized);
  const replaced = replaceImageSources(sanitized, assetsByUrl);
  const after = checkHtml(replaced.html);
  const safety = checkHtmlSafety(replaced.html);
  return {
    html: replaced.html,
    missingAssets: replaced.missing,
    valid: before.valid && after.valid && safety.valid,
    errors: [...before.errors, ...after.errors, ...safety.errors],
  };
}

module.exports = {
  assetKey,
  checkHtml,
  checkHtmlSafety,
  sanitizeHtml,
  normalizeHtml,
  replaceImageSources,
};
