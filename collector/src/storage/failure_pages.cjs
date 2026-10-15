'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../shared/utils.cjs');

function failurePath(dataDir, runId) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error('无效的 metadataRunId');
  return path.join(dataDir, 'failure-pages', `metadata-${Number(runId)}.json`);
}

// Capture the current server page before closing Chrome; never navigate or
// execute a provider page in the application's origin.
async function captureFailurePage(page, options, runId, error) {
  if (!page) return;
  try {
    const info = await page.evaluate(() => ({
      title: document.title || '',
      url: location.href,
      text: (document.body?.innerText || '').slice(0, 4000),
    }));
    let screenshot = null;
    try {
      const bytes = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: 5000 });
      if (bytes.length <= 1024 * 1024) screenshot = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    } catch (failure) {
      console.warn(`[现场] 截图失败：${failure.message}`);
    }
    writeFileAtomic(
      failurePath(options.dataDir, runId),
      JSON.stringify({
        available: true,
        runId,
        capturedAt: new Date().toISOString(),
        title: String(info.title).slice(0, 200),
        url: String(info.url).slice(0, 2000),
        text: info.text,
        error: String(error.message || error).slice(0, 1000),
        screenshot,
      }),
    );
  } catch (failure) {
    console.warn(`[现场] 保存失败：${failure.message}`);
  }
}

function readFailurePage(dataDir, runId) {
  try {
    return JSON.parse(fs.readFileSync(failurePath(dataDir, runId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, runId: Number(runId) };
    throw error;
  }
}

module.exports = { captureFailurePage, readFailurePage };
