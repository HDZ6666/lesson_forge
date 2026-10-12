import gzip
import json
import tempfile
import unittest
from pathlib import Path

from diagnostic_reader import collect_diagnostics


class ReaderTest(unittest.TestCase):
    def test_incremental_members_crash_tail_and_no_duplicate_events(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'events-test.jsonl.gz'
            first=gzip.compress((json.dumps({'eventId':'a','kind':'verification_detected'})+'\n').encode())
            second=gzip.compress((json.dumps({'eventId':'b','kind':'verification_api_recovered'})+'\n').encode())
            path.write_bytes(first+second[:12])
            result,cursors=collect_diagnostics([root],{})
            self.assertEqual([r['eventId'] for r in result['events']],['a'])
            with path.open('ab') as f:f.write(second[12:])
            result,cursors=collect_diagnostics([root],cursors)
            self.assertEqual([r['eventId'] for r in result['events']],['b'])
            result,_=collect_diagnostics([root],cursors)
            self.assertEqual(result['events'],[])

    def test_success_request_counts_and_failure_kept(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'events-test.jsonl.gz'
            rows=[{'kind':'source_request_finished','eventId':'ok','status':200,'elapsedMs':50},
                  {'kind':'source_request_finished','eventId':'error','status':403,'elapsedMs':20}]
            p.write_bytes(b''.join(gzip.compress((json.dumps(r)+'\n').encode()) for r in rows))
            result,_=collect_diagnostics([root],{})
            self.assertEqual(result['counts']['source_request_finished'],2)
            self.assertEqual([x['eventId'] for x in result['events']],['error'])
