'use strict';

const { normalizeWhitespace } = require('./utils.cjs');

/**
 * Small dependency-free HTML fragment scanner shared by the collectors.  It is
 * deliberately limited to the provider's stable markup, but balances nested
 * elements so a table or an option containing divs cannot truncate a block.
 */

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

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp|#x27);/gi, (full, token) => {
    const lower = String(token).toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos' || lower === '#x27') return "'";
    if (lower === 'nbsp') return '\u00a0';
    if (lower.startsWith('#x')) {
      const number = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(number) ? String.fromCodePoint(number) : full;
    }
    if (lower.startsWith('#')) {
      const number = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : full;
    }
    return full;
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value ?? '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function classListFromAttrs(attrs) {
  return String(attrs?.class || '')
    .split(/\s+/)
    .filter(Boolean);
}

function hasClass(attrs, wanted) {
  return classListFromAttrs(attrs).includes(wanted);
}

/**
 * Parse an opening tag into an attribute map with entity-decoded values.
 * Keys are stored both as written and lower-cased.
 */
function parseAttributes(openTag) {
  const text = String(openTag || '').replace(/^<[^\s>]+\s*|\s*\/?>$/g, '');
  const attrs = {};
  const attrPattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrPattern.exec(text))) {
    const key = String(match[1]);
    const value = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    attrs[key] = value;
    attrs[key.toLowerCase()] = value;
  }
  return attrs;
}

/**
 * Attribute parser used by the metadata collector: keys are lower-cased and
 * values are kept exactly as written (no entity decoding) so stored source
 * URLs and raw_json signatures stay byte-identical to earlier runs.
 */
function parseAttributesRaw(tag) {
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
    const attributes = parseAttributesRaw(match[1]);
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

function openingTagAt(html, index) {
  const rest = String(html).slice(index);
  const match = rest.match(/^<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/);
  if (!match) return null;
  return {
    tag: String(match[1]).toLowerCase(),
    text: match[0],
    end: index + match[0].length,
    attrs: parseAttributes(match[0]),
  };
}

function findMatchingTag(html, start, tag) {
  const source = String(html);
  const wanted = String(tag).toLowerCase();
  const tokenPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/g;
  tokenPattern.lastIndex = Number(start) || 0;
  let depth = 1;
  let match;
  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    const tokenTag = String(match[1] || '').toLowerCase();
    if (!tokenTag || token.startsWith('<!--')) continue;
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tokenTag);
    if (tokenTag !== wanted) continue;
    if (!closing && !selfClosing) depth += 1;
    if (closing) {
      depth -= 1;
      if (depth === 0) return { start: match.index, end: tokenPattern.lastIndex };
    }
  }
  return null;
}

function findElements(html, predicate, wantedTag = null) {
  const source = String(html ?? '');
  const result = [];
  const openPattern = /<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/g;
  let match;
  while ((match = openPattern.exec(source))) {
    const token = match[0];
    if (/^<\//.test(token) || /^<!--/.test(token) || /\/\s*>$/.test(token)) continue;
    const tag = String(match[1]).toLowerCase();
    if (wantedTag && tag !== String(wantedTag).toLowerCase()) continue;
    const attrs = parseAttributes(token);
    if (!predicate(attrs, tag, token)) continue;
    const start = match.index;
    if (VOID_TAGS.has(tag)) {
      result.push({
        tag,
        attrs,
        open: token,
        inner: '',
        outer: token,
        start,
        end: openPattern.lastIndex,
      });
      continue;
    }
    const closing = findMatchingTag(source, openPattern.lastIndex, tag);
    if (!closing) continue;
    result.push({
      tag,
      attrs,
      open: token,
      inner: source.slice(openPattern.lastIndex, closing.start),
      outer: source.slice(start, closing.end),
      start,
      end: closing.end,
    });
  }
  return result;
}

function findByClass(html, className, tag = null) {
  return findElements(html, (attrs) => hasClass(attrs, className), tag);
}

function firstByClass(html, className, tag = null) {
  return findByClass(html, className, tag)[0] || null;
}

function findByAttribute(html, attribute, expected = null, tag = null) {
  const wanted = String(attribute).toLowerCase();
  return findElements(
    html,
    (attrs) => {
      const value = attrs[wanted] ?? attrs[attribute];
      return value !== undefined && (expected == null || String(value) === String(expected));
    },
    tag,
  );
}

function firstByAttribute(html, attribute, expected = null, tag = null) {
  return findByAttribute(html, attribute, expected, tag)[0] || null;
}

function elementText(element) {
  return element ? stripHtml(element.inner) : '';
}

function attr(attrs, name, fallback = null) {
  if (!attrs) return fallback;
  const wanted = String(name).toLowerCase();
  return attrs[wanted] ?? attrs[name] ?? fallback;
}

function absoluteUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

module.exports = {
  VOID_TAGS,
  absoluteUrl,
  attr,
  classListFromAttrs,
  decodeHtmlEntities,
  elementText,
  findByAttribute,
  findByClass,
  findElements,
  findMatchingTag,
  firstByAttribute,
  firstByClass,
  hasClass,
  openingTagAt,
  parseAnchors,
  parseAttributes,
  parseAttributesRaw,
  sliceElementById,
  stripHtml,
};
