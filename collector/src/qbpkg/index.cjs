'use strict';

const builder = require('./builder.cjs');
const validator = require('./validator.cjs');
const normalize = require('./normalize.cjs');
const schema = require('./schema.cjs');

module.exports = {
  ...builder,
  ...validator,
  ...normalize,
  ...schema,
  buildQbPkg: builder.buildPackage,
  build: builder.buildPackage,
  verifyQbPkg: validator.verifyPackage,
  verify: validator.verifyPackage,
  validatePackage: validator.verifyPackage,
  computeAssetKey: normalize.assetKey,
  normalizeQuestionHtml: normalize.normalizeHtml,
};
