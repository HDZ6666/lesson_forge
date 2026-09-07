'use strict';

/**
 * Compatibility facade.  Bounded collector snapshot / candidate reads live in
 * src/storage/readers/.  Export names are unchanged.
 */
module.exports = require('../src/storage/readers/index.cjs');
