'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {SyncStore} = require('../legacy/zujuan_sync.cjs');
const {reclaimRun} = require('../src/storage/result_cleanup.cjs');
const {readRunSnapshotPage} = require('../src/storage/readers/index.cjs');

function seed(store, questionId, assetPath) {
  const id = store.beginRun({textbookIds:['tb1'],details:false,downloadAssets:false});
  const node = {externalId:'c1',level:1,name:'目录',path:'/c1',sortOrder:1};
  store.saveRunCatalogTree(id,'tb1',[node]);
  store.saveRunQuestion(id,'tb1',{externalId:questionId,questionType:'单选题',contentHtml:'<p>题目</p>',plainText:'题目',detailFetched:true},'c1');
  store.saveRunQuestionCatalogs(id,'tb1',questionId,[node]);
  if(assetPath) store.saveRunQuestionAssets(id,'tb1',questionId,[{assetKey:'a',assetType:'image',sourceUrl:'https://example.com/a.png',storagePath:assetPath,contentSha256:'a'.repeat(64),byteSize:4,mimeType:'image/png'}]);
  store.finishRun(id,'failed',{pagesOk:1,questionsSeen:1,errors:1},'部分成果');
  return id;
}

test('回收旧快照保留最新、共享素材、任务头和不可变保护；重复回收幂等', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'result-cleanup-'));
  const dbPath=path.join(dir,'collector.sqlite3');
  const store=new SyncStore(dbPath,{dataDir:dir});
  try {
    fs.mkdirSync(path.join(dir,'assets'));
    fs.writeFileSync(path.join(dir,'assets','shared.png'),'test');
    const first=seed(store,'q1','assets/shared.png');
    const payload={textbookExternalId:'tb1',snapshotLockedAt:store.db.prepare('SELECT snapshot_locked_at FROM sync_runs WHERE id=?').get(first).snapshot_locked_at};
    assert.throws(()=>reclaimRun(dbPath,dir,first,payload),/最新成果/);
    const latest=seed(store,'q2','assets/shared.png');
    assert.throws(()=>reclaimRun(dbPath,dir,first,{...payload,textbookExternalId:'other'}),/身份/);
    const done=reclaimRun(dbPath,dir,first,payload);
    assert.equal(done.runId,first);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sync_run_question_items WHERE run_id=?').get(first).n,0);
    assert.equal(store.db.prepare('SELECT question_item_count n FROM sync_runs WHERE id=?').get(first).n,1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sync_run_question_items WHERE run_id=?').get(latest).n,1);
    assert.ok(fs.existsSync(path.join(dir,'assets/shared.png')));
    assert.throws(()=>store.db.prepare('DELETE FROM sync_run_question_items WHERE run_id=?').run(latest),/immutable/);
    assert.throws(()=>readRunSnapshotPage(dbPath,first,{textbookExternalId:'tb1',collection:'questions',sealedForImport:true}),/已入库并回收/);
    assert.equal(reclaimRun(dbPath,dir,first,payload).reclaimedAt,done.reclaimedAt);
    const third=seed(store,'q3',null);
    const seal=store.db.prepare('SELECT snapshot_locked_at FROM sync_runs WHERE id=?').get(latest).snapshot_locked_at;
    reclaimRun(dbPath,dir,latest,{...payload,snapshotLockedAt:seal});
    assert.ok(!fs.existsSync(path.join(dir,'assets/shared.png')));
    assert.ok(third>latest);
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('仍在运行时不回收任何旧成果', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-active-'));const dbPath=path.join(dir,'db.sqlite3');
 const store=new SyncStore(dbPath,{dataDir:dir});
 try {
  const old=seed(store,'q1');seed(store,'q2');store.beginRun({textbookIds:['tb2'],details:false,downloadAssets:false});
  const snapshotLockedAt=store.db.prepare('SELECT snapshot_locked_at FROM sync_runs WHERE id=?').get(old).snapshot_locked_at;
  assert.throws(()=>reclaimRun(dbPath,dir,old,{textbookExternalId:'tb1',snapshotLockedAt}),/采集进行中/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM sync_run_question_items WHERE run_id=?').get(old).n,1);
 } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
