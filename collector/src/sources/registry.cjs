'use strict';

// Only adapters whose parser and storage identity have been verified may write
// to the collector. Other subjects can be registered in Service meanwhile.
const MATH_NAMESPACE = 'zujuan:junior:math';

function assertMathSource(options = {}) {
  if ((options.sourceNamespace != null && options.sourceNamespace !== MATH_NAMESPACE)
      || String(options.bankPath ?? 'czsx') !== 'czsx'
      || String(options.bankId ?? 2) !== '2') {
    throw new Error('该学科来源尚未验证，当前 Collector 仅接入组卷网初中数学。');
  }
  if (options.seedUrl != null) {
    const seed = new URL(options.seedUrl);
    if (seed.protocol !== 'https:' || seed.hostname !== 'zujuan.xkw.com'
        || !seed.pathname.startsWith('/czsx/')) {
      throw new Error('教材发现入口必须属于已验证的初中数学来源。');
    }
  }
  return MATH_NAMESPACE;
}

module.exports = { MATH_NAMESPACE, assertMathSource };
