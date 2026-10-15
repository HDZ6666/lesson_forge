'use strict';

// Parser / classifier regressions built from real (trimmed) provider responses
// and synthetic reproductions of recorded production incidents (COL-003,
// COL-010, COL-012).  These modules are pure: no network, browser or SQLite.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyListPageContent,
  classifyQuestionResponse,
  isProtectionText,
  looksLikeHtml,
  pageResultFromError,
  parseJsonEnvelope,
} = require('../src/sources/zujuan/response_classifier.cjs');
const {
  finalizeQuestion,
  parseQuestionBlock,
  parseQuestionListPayload,
} = require('../src/sources/zujuan/question_parser.cjs');
const {
  parseTextbooksFromApiHtml,
  parseTextbooksFromHtml,
  parseVersionsFromHtml,
  validateDiscovery,
} = require('../src/sources/zujuan/metadata_parser.cjs');
const { normalizeCatalogTree, selectCatalogs } = require('../src/sources/zujuan/catalog_parser.cjs');
const { buildQuestionListRequest } = require('../src/sources/zujuan/request.cjs');
const { catalogLastPage, growTargetPages } = require('../src/policies/pagination.cjs');
const { PAGE_RESULT } = require('../src/sources/zujuan/constants.cjs');
const { validatePageResult } = require('../zujuan_question_sync.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'zujuan');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function stripFixtureHeader(html) {
  return html.replace(/^<!--[\s\S]*?-->\s*/, '');
}

function envelope(html, total = 10) {
  return JSON.stringify({ code: '0', msg: 'ok', data: { html, total } });
}

function syntheticCard(questionId, stemHtml, extraClass = '') {
  return `
<div class=" tk-quest-item quesroot ${extraClass}" questionindex="0" questionid="${questionId}" bankid="2">
  <div class="ques-additional">
    <div class="msg-box"><div class="left-msg">
      <span class="addi-info"><span class="info-cnt">单选题</span></span>
      <span class="addi-info"><span class="info-cnt">容易（0.85）</span></span>
    </div></div>
  </div>
  <div class="wrapper quesdiv" id="quesdiv${questionId}">
    <div class="exam-item__cnt ">1 . ${stemHtml}</div>
  </div>
  <div class="ques-opt">
    <a class="addques" quesid="${questionId}" qyid="1101" qyname="单选题" qdid="1" qdname="容易" qdvalue="0.85"
       categoryid="261285" categoryname="概率初步" href="javascript:;">加入试卷</a>
  </div>
</div>`;
}

const REAL_CARD = stripFixtureHeader(fixture('list-261285-p470-q26996136.card.html'));

test('COL-003 真实题卡：题干含“安全威胁”的合法题目正常解析且不被判为防护', () => {
  const text = envelope(REAL_CARD, 10012);
  const classification = classifyQuestionResponse({ status: 200, text });
  assert.equal(classification.kind, 'ok');
  assert.equal(classification.payload?.code, '0');

  const parsed = parseQuestionListPayload(classification.payload);
  assert.equal(parsed.questionIds.length, 1);
  assert.equal(parsed.questionIds[0], '26996136');
  const question = parsed.questions[0];
  assert.match(question.plainText, /安全威胁/);
  assert.equal(question.questionType, '解答题-问答题');
  assert.equal(question.answerStatus, 'not_collected');
  assert.equal(question.contentSource, 'list_api');
  assert.equal(parsed.total, 10012);
});

test('COL-003 新入口：合法 JSON 题干包含验证码/captcha/forbidden 等防护词仍判为正常响应', () => {
  const stem =
    '小明在网站登录时需要输入四位数字<b>验证码</b>（captcha），若忘记密码会提示 forbidden，' +
    '求验证码首位为奇数的概率。';
  const text = envelope(syntheticCard('90000001', stem));
  assert.equal(isProtectionText(text), true, '样本必须真的包含防护词，否则测试无意义');
  const classification = classifyQuestionResponse({ status: 200, text });
  assert.equal(classification.kind, 'ok');
  const parsed = parseQuestionListPayload(classification.payload);
  assert.deepEqual(parsed.questionIds, ['90000001']);
  assert.match(parsed.questions[0].plainText, /验证码/);
});

test('真正的防护 HTML 与带防护词的错误信封仍被识别为 verification', () => {
  const protectionPage = [
    '<!DOCTYPE html><html><head><title>安全验证</title></head>',
    '<body><div id="parm_0"></div><p>请按住滑块，拖动到最右边完成验证</p></body></html>',
  ].join('');
  assert.equal(looksLikeHtml(protectionPage), true);
  assert.equal(classifyQuestionResponse({ status: 200, text: protectionPage }).kind, 'verification');
  assert.equal(classifyQuestionResponse({ status: 200, text: protectionPage }).code, 'json_html');

  const blockedEnvelope = JSON.stringify({ code: '403', msg: '访问验证，请完成滑块验证后重试', data: null });
  assert.equal(classifyQuestionResponse({ status: 200, text: blockedEnvelope }).kind, 'verification');

  const plainError = JSON.stringify({ code: '1', msg: '参数错误', data: null });
  const plain = classifyQuestionResponse({ status: 200, text: plainError });
  assert.equal(plain.kind, 'ok');
  assert.throws(() => parseQuestionListPayload(plain.payload), /list_api_contract|题目列表接口返回异常/);

  // Bare 403 / ordinary HTML are diagnosis cases, not a slider (spec A24).
  assert.equal(classifyQuestionResponse({ status: 403, text: 'forbidden' }).kind, 'fatal');
  assert.equal(classifyQuestionResponse({ status: 403, text: 'forbidden' }).needsDiagnosis, true);
  assert.equal(classifyQuestionResponse({ status: 403, text: protectionPage }).kind, 'verification');
  assert.equal(
    classifyQuestionResponse({ status: 405, text: '<html><body>Method Not Allowed</body></html>' }).kind,
    'fatal',
  );
  const gateway = '<!DOCTYPE html><html><head><title>502</title></head><body>Bad gateway</body></html>';
  assert.equal(classifyQuestionResponse({ status: 200, text: gateway }).code, 'unexpected_html');
  assert.equal(classifyQuestionResponse({ status: 503, text: 'busy' }).kind, 'retry');
  assert.equal(parseJsonEnvelope('not json'), null);
  assert.equal(parseJsonEnvelope('[1,2]'), null);
});

test('元数据真实片段：26 个版本 ID 稳定，5 本教材缺 bootstrap 章节时保持为空不伪造', () => {
  const html = stripFixtureHeader(fixture('metadata-seed-entry.fragment.html'));
  const versions = parseVersionsFromHtml(html, { sourceUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/' });
  assert.equal(versions.length, 26);
  assert.ok(versions.every((version) => /^\d+$/.test(version.externalVersionId)));
  assert.equal(versions[0].versionName, '人教版');

  const textbooks = parseTextbooksFromHtml(html, { versionExternalId: versions[0].externalVersionId });
  assert.equal(textbooks.length, 5);
  assert.ok(textbooks.every((textbook) => /^\d+$/.test(textbook.externalTextbookId)));
  assert.ok(textbooks.every((textbook) => textbook.bootstrapChapterExternalId === null));
  assert.ok(textbooks.every((textbook) => textbook.sourceUrl.startsWith('https://zujuan.xkw.com/')));

  const validation = validateDiscovery(versions, textbooks);
  assert.equal(validation.missingIds.length, 0);
  assert.equal(validation.duplicateIds.length, 0);
  assert.equal(validation.missingBootstrapChapters.length, 5);

  // The chaptertextbooks API returns the inner fragment without the wrapper.
  const inner = html.match(/<div id="chapter_textbooks">([\s\S]*)<\/div>\s*$/)[1];
  const fromApi = parseTextbooksFromApiHtml(inner, { versionExternalId: versions[0].externalVersionId });
  assert.equal(fromApi.length, 5);
});

test('COL-010 合成题卡：失效公式 PNG 与主示意图分别识别，跳过公式后主图与题干保留', () => {
  const formulaUrl = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/affe150b3da936aacebc1df56d98cf84.png';
  const figureUrl = 'https://staticzujuan.xkw.com/quesimg/2025/06/figure-19109827.png';
  const stem = `如图，在平面直角<img src="${formulaUrl}">坐标系中<img src="${figureUrl}">求点 P 的坐标。`;
  const question = parseQuestionBlock(syntheticCard('19109827', stem));
  assert.equal(question.externalId, '19109827');
  assert.deepEqual(
    question.assets.map((asset) => asset.type),
    ['formula_image', 'question_image'],
  );
  assert.equal(question.hasFormula, true);
  assert.equal(question.hasImage, true);

  const skippedFormula = {
    ...question,
    assets: question.assets.map((asset) =>
      asset.type === 'formula_image' ? { ...asset, skipped: true, skipReason: 'http_404' } : asset,
    ),
  };
  const finalized = finalizeQuestion(skippedFormula);
  assert.equal(finalized.assets.length, 1);
  assert.equal(finalized.assets[0].type, 'question_image');
  assert.ok(!finalized.contentHtml.includes(formulaUrl), '被跳过的公式图必须从正式 HTML 移除');
  assert.ok(finalized.contentHtml.includes('data-asset-key'), '主示意图必须改写为素材键');
  assert.match(finalized.plainText, /平面直角\s*坐标系中/);
  assert.equal(finalized.hasFormula, false);
  assert.equal(finalized.hasImage, true);
  assert.equal(finalized.answerStatus, 'not_collected');
});

test('COL-012 合成样本：第 1001 页与此前页面题号完全相同时判为重复页而非整本失败', () => {
  const cards = ['26994121', '26994185', '26994125'].map((id) => syntheticCard(id, `题目 ${id}`)).join('\n');
  const page1000 = parseQuestionListPayload(envelope(cards, 10012));
  const page1001 = parseQuestionListPayload(envelope(cards, 10012));
  const seen = new Set();
  const signature = validatePageResult(page1000, 1000, null, seen);
  assert.ok(signature);
  seen.add(signature);
  let error = null;
  try {
    validatePageResult(page1001, 1001, null, seen);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '重复页必须以可分类的错误返回');
  assert.equal(error.code, 'pagination_loop');
  assert.equal(pageResultFromError(error), PAGE_RESULT.DUPLICATE_PAGE);
  assert.equal(pageResultFromError({ code: 'list_api_contract' }), PAGE_RESULT.PARSE_FAILED);
  assert.equal(pageResultFromError(new Error('boom')), PAGE_RESULT.REQUEST_FAILED);
});

test('空页与解析失败分别分类；total 增大只扩展目标页数', () => {
  assert.equal(classifyListPageContent('', []), PAGE_RESULT.EMPTY_PAGE);
  assert.equal(classifyListPageContent('<div class="tk-quest-item"></div>', []), PAGE_RESULT.PARSE_FAILED);
  assert.equal(classifyListPageContent('<div></div>', ['1']), PAGE_RESULT.SUCCESS);
  assert.equal(growTargetPages(1002, 10013, 10), 1002);
  assert.equal(growTargetPages(1002, 10021, 10), 1003);
  assert.equal(growTargetPages(50, null, 10), 50);
  assert.equal(catalogLastPage({ maxPagesProvided: true, maxPages: 3 }), 3);
  assert.equal(catalogLastPage({}), 10000);
});

test('目录树与列表请求：知识点节点映射 catelogTokpointId，普通目录映射 categoryId', () => {
  const tree = normalizeCatalogTree(
    {
      id: '260617',
      title: '九年级上册',
      children: [
        {
          id: '261285',
          title: '第六章 概率的进一步认识',
          href: '/czsx/zj261285/',
          children: [
            { id: '223709', title: '用树状图或表格求概率', href: '/czsx/zj261285/ctk223709/', isKnowledge: 1 },
          ],
        },
      ],
    },
    { textbookId: '260617' },
  );
  assert.equal(tree.nodes.length, 2);
  const [chapter, point] = tree.nodes;
  assert.equal(chapter.categoryId, '261285');
  assert.equal(chapter.catelogTokpointId, '0');
  assert.equal(point.categoryId, '261285');
  assert.equal(point.catelogTokpointId, '223709');
  assert.equal(point.type, 'point');
  assert.deepEqual(
    selectCatalogs(tree, { catalogLevels: [2] }).map((node) => node.externalId),
    ['223709'],
  );

  const request = buildQuestionListRequest({ bankId: 2 }, point, 7);
  assert.equal(request.url, 'https://zujuan.xkw.com/zujuan-api/question/list');
  const body = new URLSearchParams(request.body);
  assert.equal(body.get('categoryId'), '261285');
  assert.equal(body.get('catelogTokpointId'), '223709');
  assert.equal(body.get('curPage'), '7');
  assert.equal(request.credentials, 'include');
});

test('重复知识点按教材章节保留两处，原始来源 ID 仍用于请求', () => {
  const raw = {
    id: '195861',
    title: '七年级上册',
    children: ['196009', '196010'].map((id) => ({
      id,
      title: `章节 ${id}`,
      href: `/czsx/zj${id}/`,
      children: [
        {
          id: '4712',
          title: '根据点在数轴的位置判断式子的正负',
          isKnowledge: 1,
          href: `/czsx/zj${id}/ctk4712`,
        },
      ],
    })),
  };
  const tree = normalizeCatalogTree(raw, { textbookId: '195861' });
  const points = selectCatalogs(tree, { catalogIds: ['4712'] });
  assert.deepEqual(
    points.map((p) => p.externalId),
    ['ctk_196009_4712', 'ctk_196010_4712'],
  );
  for (const point of points) {
    assert.equal(point.parentExternalId, point.categoryId);
    assert.deepEqual(point.ancestorIds, [point.categoryId, point.externalId]);
    const body = new URLSearchParams(buildQuestionListRequest({ bankId: 2 }, point, 1).body);
    assert.equal(body.get('categoryId'), point.categoryId);
    assert.equal(body.get('catelogTokpointId'), '4712');
  }
  assert.deepEqual(selectCatalogs(tree, { catalogIds: ['ctk_196009_4712', '4712'] }), points);
  const reversed = normalizeCatalogTree({ ...raw, children: [...raw.children].reverse() }, { textbookId: '195861' });
  assert.deepEqual(reversed.nodes.map((n) => n.externalId).sort(), tree.nodes.map((n) => n.externalId).sort());
  raw.children[0].children.push({ ...raw.children[0].children[0] });
  assert.throws(() => normalizeCatalogTree(raw, { textbookId: '195861' }), /目录 ID 重复：4712；位置/);
});
