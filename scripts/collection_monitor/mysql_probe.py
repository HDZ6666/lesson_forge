"""Read workflow metadata only; executed inside the existing service container."""
import json
import os

import pymysql

QUERIES = {
    'plans': 'SELECT plan_id,subject_id,plan_name,cycle_no,cycle_name,cycle_state,control_state,enabled,list_concurrency,cycle_targets,cycle_started_at,cycle_finished_at,next_cycle_at,discovery_error FROM qb_sync_plan',
    'cycles': 'SELECT plan_id,cycle_no,cycle_name,status,targets,started_at,finished_at FROM qb_sync_cycle',
    'jobs': 'SELECT run_id,logical_task_id,collector_job_id,task_module,status,phase,options_json,create_time,started_at,finished_at,error_message,dispatch_error,dispatch_not_before,question_count,progress_percent FROM qb_sync_job',
    'scopes': 'SELECT run_id,scope_id,collector_run_id,external_textbook_id,local_textbook_id,version_name_snapshot,textbook_name_snapshot,status FROM qb_sync_job_scope WHERE collector_run_id IS NOT NULL',
    'intakes': 'SELECT intake_id,task_id,scope_id,collector_run_id,status,attempt_count,attempt_limit,next_attempt_at,error_kind,error_message,update_time FROM qb_question_import_intake',
    'imports': 'SELECT import_id,task_id,scope_id,collector_run_id,status,stage,question_count,committed_cursor,accepted_count,quarantined_count,error_message,finished_at,update_time FROM qb_question_import',
    'issues': 'SELECT issue_id,latest_task_id,status,reason FROM qb_sync_issue',
}
# Session/round columns arrive with service migration 029; older databases
# fall back to the base queries so the monitor keeps working during rollout.
SESSION_QUERIES = {
    'plans': QUERIES['plans'].replace(' FROM qb_sync_plan', ',session_no,session_round,max_rounds,session_end_reason,session_mode FROM qb_sync_plan'),
    'cycles': QUERIES['cycles'].replace(' FROM qb_sync_cycle', ',session_no,round_no,legacy,end_reason,summary_json FROM qb_sync_cycle'),
    'control': 'SELECT resource_wait_json FROM qb_sync_control WHERE control_id=1',
}
OPTION_KEYS = ('autoPlanId', 'manualPlanId', 'autoCycleNo', 'autoCycleName', 'textbookIds',
               'textbookExternalIds', 'versionName', 'textbookNames', 'listConcurrency',
               'autoResumePending', 'planResumePending', 'snapshotReclaimed', 'syncMode',
               'supplementRun', 'pinnedOnce')
SETTINGS = ('BANK_COLLECTION_START_MEMORY_MIB', 'BANK_IMPORT_MIN_MEMORY_MIB',
            'BANK_MIN_MEMORY_FREE_MIB', 'BANK_MIN_DISK_FREE_MIB', 'BANK_RESULT_RETENTION_HOURS')


def main():
    config = json.loads(os.environ['DB_SOURCES'])['primary']
    db = pymysql.connect(host=config['db_host'], port=config['db_port'],
                         user=config['db_username'], password=config['db_password'],
                         database=config['db_database'], connect_timeout=3, read_timeout=8,
                         cursorclass=pymysql.cursors.DictCursor, autocommit=True)
    try:
        data = {'settings': {k: os.environ.get(k) for k in SETTINGS}}
        with db.cursor() as cursor:
            for name, query in QUERIES.items():
                try:
                    cursor.execute(SESSION_QUERIES.get(name, query))
                except pymysql.MySQLError:
                    cursor.execute(query)
                data[name] = cursor.fetchall()
            try:
                cursor.execute(SESSION_QUERIES['control'])
                data['control'] = cursor.fetchall()
            except pymysql.MySQLError:
                data['control'] = []
        for job in data['jobs']:
            options = json.loads(job.pop('options_json') or '{}')
            job['options'] = {k: options[k] for k in OPTION_KEYS if k in options}
        print(json.dumps(data, ensure_ascii=False, default=str))
    finally:
        db.close()


if __name__ == '__main__':
    main()
