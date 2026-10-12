'use strict';
// No source-site request, snapshot construction, checkpoint or database write.
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
(async () => {
  const path = process.env.COLLECTOR_DB || '/data/zujuan.sqlite3';
  const db = new DatabaseSync(path, {readOnly: true});
  db.exec('PRAGMA busy_timeout=1000');
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  const rows = (table, columns='*') => names.has(table) ? db.prepare(`SELECT ${columns} FROM ${table}`).all() : [];
  const data = {};
  try {
    data.runs = rows('sync_runs', 'id,started_at,finished_at,status,scope_json,pages_ok,questions_seen,question_item_count,error_count,message,scan_complete,data_complete');
    for (const run of data.runs) {
      const scope=JSON.parse(run.scope_json || '{}'); delete run.scope_json;
      run.scope=pick(scope,['textbookId','resumeFromRunId','textbookExpectedTotal','sealedCoverageEvidence']);
    }
    data.metadata = rows('source_metadata_runs').map(r=>pick(r,['id','started_at','finished_at','status','message','error_count','versions_seen','textbooks_seen']));
    data.errors = rows('sync_errors', 'id,run_id,stage,error_code,message,created_at');
    data.control = rows('collector_source_control');
    data.jobs = rows('collector_jobs','id,status,collector_run_id,metadata_run_id,payload_json').map(r=>{
      const p=JSON.parse(r.payload_json || '{}'); delete r.payload_json;
      return {...r,...pick(p,['runType','startedAt','finishedAt','listConcurrency','waitingReason','waitingSince',
        'errorCode','errorMessage','lastErrorEvent','childRssMb','childRssPeakMb','progressPercent','scopeItems'])};
    });
    data.catalogs = rows('sync_run_catalog_progress','run_id,catalog_external_id,expected_total,last_completed_page,scan_complete,data_complete,failed_page_count,duplicate_page_count,stall_reason,observed_at,highest_attempted_page');
    data.cleanup = rows('sync_result_cleanup','run_id,reclaimed_at,deleted_bytes,finished');
    const size = suffix => {try{return fs.statSync(path+suffix).size;}catch{return 0;}};
    data.storage = {databaseBytes:size(''),walBytes:size('-wal'),
      reusableBytes:Number(db.prepare('PRAGMA freelist_count').get().freelist_count)*Number(db.prepare('PRAGMA page_size').get().page_size)};
    data.settings = Object.fromEntries(['COLLECTOR_MIN_MEMORY_FREE_MIB','COLLECTOR_MIN_DISK_FREE_MIB',
      'COLLECTOR_CHILD_MAX_RSS_MB','COLLECTOR_LIST_CONCURRENCY','COLLECTOR_ASSET_CONCURRENCY',
      'COLLECTOR_DELAY_MIN_MS','COLLECTOR_DELAY_MAX_MS'].map(k=>[k,process.env[k]]));
  } finally {db.close();}
  const start=Date.now();
  try {
    const r=await fetch('http://127.0.0.1:9110/v1/health',{
      headers:{Authorization:`Bearer ${process.env.COLLECTOR_API_TOKEN}`},signal:AbortSignal.timeout(3000)});
    data.health={status:r.status,elapsedMs:Date.now()-start,...(r.ok?await r.json():{})};
  } catch(error) {data.health={error:error.name,elapsedMs:Date.now()-start};}
  console.log(JSON.stringify(data));
})().catch(error=>{console.error(error.name);process.exitCode=1;});
