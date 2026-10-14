import copy
import importlib.util
import sqlite3
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).with_name('monitor.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript(monitor.SCHEMA)
        self.addCleanup(self.db.close)

    def test_pause_polling_deduplicated_and_recovery_duration_preserved(self):
        monitor.transition(self.db, 'resource', {'paused': False}, '2026-10-12T01:00:00+00:00')
        monitor.transition(self.db, 'resource', {'paused': True}, '2026-10-12T01:01:00+00:00')
        monitor.transition(self.db, 'resource', {'paused': True}, '2026-10-12T01:02:00+00:00')
        monitor.transition(self.db, 'resource', {'paused': False}, '2026-10-12T01:05:00+00:00')
        self.assertEqual(self.db.execute('SELECT count(*) FROM events').fetchone()[0], 3)
        import json
        event = json.loads(self.db.execute('SELECT payload FROM events ORDER BY id DESC LIMIT 1').fetchone()[0])
        self.assertEqual(event['observedDurationSeconds'], 240)
        self.assertTrue(event['previous']['paused'])

    def test_partial_and_latest_retry_not_counted_as_completed(self):
        data = {'cycles':[{'plan_id':1,'cycle_no':1,'targets':'[1,2,3,4]','status':'running'}],
                'jobs':[
                    {'run_id':1,'status':'success','options':{'autoPlanId':1,'autoCycleNo':1,'textbookIds':[1]}},
                    {'run_id':2,'status':'success','options':{'autoPlanId':1,'autoCycleNo':1,'textbookIds':[2]}},
                    {'run_id':3,'status':'running','options':{'autoPlanId':1,'autoCycleNo':1,'textbookIds':[1]}},
                    {'run_id':4,'status':'success','options':{'autoPlanId':1,'autoCycleNo':1,'textbookIds':[3]}},
                    {'run_id':5,'status':'queued','options':{'autoPlanId':1,'autoCycleNo':2,'textbookIds':[2]}},
                ],'imports':[{'task_id':1,'status':'completed'},{'task_id':2,'status':'partial'},{'task_id':4,'status':'completed'}]}
        result = monitor.cycle_summaries(data)[0]
        self.assertEqual(result['counts'], {'collecting':1,'partial_imported':1,'fully_imported':1,'no_task':1})
        self.assertFalse(result['allFullyImported'])

    def test_session_summary_counts_rounds_and_real_new_counts(self):
        data = {'cycles':[
            {'plan_id':1,'cycle_no':1,'session_no':1,'round_no':1,'legacy':1,'end_reason':None,'summary_json':None},
            {'plan_id':1,'cycle_no':2,'session_no':2,'round_no':1,'legacy':0,'end_reason':None,
             'summary_json':'{"newQuestionCount":5000,"newRelationCount":5100,"decision":"continue"}'},
            {'plan_id':1,'cycle_no':3,'session_no':2,'round_no':2,'legacy':0,'end_reason':'no_new',
             'summary_json':{'newQuestionCount':0,'newRelationCount':0}},
        ]}
        sessions = monitor.session_summaries(data)
        self.assertEqual([(s['sessionNo'], s['rounds'], s['endReason']) for s in sessions], [(1,1,None),(2,2,'no_new')])
        self.assertEqual(sessions[1]['newQuestionCount'], 5000)
        self.assertTrue(sessions[0]['legacy'])

    def test_read_errors_are_visible_and_do_not_fake_recovery(self):
        data = self.fixture()
        monitor.ingest(self.db, data)
        failed = copy.deepcopy(data)
        failed['at'] = '2026-10-12T07:01:00+00:00'
        failed.pop('collector')
        failed['probeErrors'] = {'collector':'TimeoutExpired'}
        monitor.ingest(self.db, failed)
        self.assertEqual(monitor.summary(self.db, failed)['probeErrors'], {'collector':'TimeoutExpired'})
        self.assertEqual(self.db.execute("SELECT count(*) FROM events WHERE entity='source:control'").fetchone()[0], 1)

    def test_run_incident_not_tripled_and_baseline_is_not_memory_at_failure(self):
        data = self.fixture()
        monitor.ingest(self.db, data)
        data['at'] = '2026-10-12T07:01:00+00:00'
        monitor.ingest(self.db, data)
        report = monitor.summary(self.db, data)
        self.assertEqual(len(report['incidents']), 1)
        row = report['incidents'][0]
        self.assertEqual(row['kind'], 'protection')
        self.assertEqual(row['elapsedSeconds'], 600)
        self.assertEqual(row['at'], '2026-10-12T01:10:00+00:00')
        self.assertEqual(row['taskId'], 163)
        self.assertNotIn('host', row)
        self.assertIn('无法还原', report['coverageNote'])

    def test_time_zones_and_memory_old_sigterm_precedence(self):
        self.assertEqual(monitor.timestamp('2026-10-12 09:14:00', local=True), '2026-10-12T09:14:00+08:00')
        self.assertEqual(monitor.seconds('2026-10-12 01:14:00', '2026-10-12T09:15:00+08:00'), 60)
        self.assertEqual(monitor.incident_kind('采集主机可用内存低于保留水位', 'stop_requested'), 'resource')
        self.assertEqual(monitor.incident_kind('收到 SIGTERM，采集在安全点停止'), 'stopped')

    def test_manual_refill_in_cycle_counts_without_mixing_older_manual_run(self):
        data = {'cycles':[{'plan_id':1,'cycle_no':1,'targets':'[2]', 'started_at':'2026-10-10 07:43:55'}],
                'jobs':[
                    {'run_id':6,'status':'failed','started_at':'2026-10-10 16:38:12',
                     'options':{'autoPlanId':1,'autoCycleNo':1,'textbookIds':[2]}},
                    {'run_id':161,'status':'cancelled','started_at':'2026-10-11 04:31:23',
                     'options':{'manualPlanId':1,'textbookIds':[2]}},
                    {'run_id':200,'status':'success','started_at':'2026-10-09 04:31:23',
                     'options':{'manualPlanId':1,'textbookIds':[2]}},
                ], 'imports':[{'task_id':161,'status':'partial'}, {'task_id':200,'status':'completed'}]}
        self.assertEqual(monitor.cycle_summaries(data)[0]['counts'], {'partial_imported':1})

    def test_http_duration_excludes_websocket_and_removes_recovery_token(self):
        rows = monitor.slow_requests('\n'.join([
            '2026-10-12T07:00:00Z x "GET /prod-api/a HTTP/1.1" 200 1 rt=5.2 urt=5.1',
            '2026-10-12T07:00:01Z x "GET /prod-api/bank/sync/manual-display/secret HTTP/1.1" 101 1 rt=60 urt=60',
            '2026-10-12T07:00:02Z x "GET /prod-api/bank/sync/manual-display/secret HTTP/1.1" 502 1 rt=0.1 urt=0.1',
            '2026-10-12T07:00:03Z x "GET /prod-api/a?token=secret HTTP/1.1" 200 1 rt=0.2 urt=0.1',
        ]))
        self.assertEqual(len(rows), 2)
        self.assertNotIn('secret', str(rows))
        self.assertEqual(rows[0]['elapsedSeconds'], 5.2)
        self.assertEqual(monitor.slow_requests('2026-10-12T07:00:00Z x \"GET /a HTTP/1.1\" 499 0 rt=0.1 urt=0.1')[0]['status'],499)

    @staticmethod
    def fixture():
        return {'at':'2026-10-12T07:00:00+00:00',
                'host':{'memoryMiB':1900,'totalMemoryMiB':3723,'diskFreeMiB':18000,'swapUsedMiB':1929},
                'probeErrors':{},'probeMs':{},
                'mysql':{'scopes':[{'collector_run_id':16,'run_id':163}]},
                'collector':{'runs':[{'id':16,'started_at':'2026-10-12T01:00:00Z',
                                      'finished_at':'2026-10-12T01:11:00Z','status':'blocked','message':'题目列表返回验证/防护',
                                      'scope':{'textbookId':'208076'}}],
                             'jobs':[{'id':'abc','collector_run_id':16,'status':'blocked','waitingSince':'2026-10-12T01:10:00Z','errorCode':'waiting_verification'}],
                             'errors':[{'run_id':16,'stage':'run','created_at':'2026-10-12T01:11:00Z','error_code':'waiting_verification'}]}}


if __name__ == '__main__':
    unittest.main()
