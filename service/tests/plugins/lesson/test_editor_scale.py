"""Opt-in reproducible synthetic scale acceptance; never contacts a source site."""
import json
import math
import os
import platform
import resource
import time
from pathlib import Path

import pytest
from sqlalchemy import insert, text

from plugins.bank.entity.do.bank_do import QbQuestion, QbQuestionCatalog, QbQuestionReadiness
from plugins.lesson.entity.vo.editor_vo import CandidateQuery, CreateDraft, Fill, QuestionFilter
from plugins.lesson.service import editor_service as editor
from plugins.lesson.service.editor_filter import filtered_ids
from plugins.lesson.service.word_export import build_question_docx
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.lesson.test_draft_editor import USER, mutation
from tests.plugins.lesson.test_draft_editor import lesson_db as lesson_db


def distribution(values):
    ordered = sorted(values)
    return {'samples': len(values), 'p50Ms': round(ordered[len(ordered)//2] * 1000, 2),
            'p95Ms': round(ordered[math.ceil(len(ordered)*.95)-1] * 1000, 2)}


@pytest.mark.skipif(os.getenv('LESSON_EDITOR_SCALE_CHECK') != '1', reason='opt-in synthetic 50k acceptance')
@pytest.mark.asyncio
async def test_editor_50k_scale(lesson_db):
    db = lesson_db
    original = await db.get(QbQuestion, 1)
    proof = await db.get(QbQuestionReadiness, 1)
    question = {c.name: getattr(original, c.name) for c in QbQuestion.__table__.columns}
    readiness = {c.name: getattr(proof, c.name) for c in QbQuestionReadiness.__table__.columns}
    for start in range(1000, 51000, 1000):
        questions, facts, relations = [], [], []
        for number in range(start, start + 1000):
            identity = f'synthetic-{number}'
            questions.append(dict(question, question_id=number, external_question_id=identity,
                                  question_type='单选题' if number % 2 else '解答题', difficulty='容易',
                                  year=2025 if number % 3 else 2024, province='山东', city='青岛'))
            facts.append(dict(readiness, question_id=number, external_question_id=identity))
            relations.append({'question_id': number, 'catalog_id': 1, 'relation_type': 'query_catalog',
                              'evidence_type': 'query_membership','create_time':original.create_time,'update_time':original.update_time})
        await db.execute(insert(QbQuestion), questions)
        await db.execute(insert(QbQuestionReadiness), facts)
        await db.execute(insert(QbQuestionCatalog), relations)
    await db.commit()
    filters = [QuestionFilter(), QuestionFilter(catalogIds=[1], questionTypes=['单选题']),
               QuestionFilter(catalogIds=[1], questionTypes=['解答题'], difficulties=['容易'], yearMin=2025,
                              provinces=['山东'], cities=['青岛'], allowImage=False, allowTable=False)]
    filter_times, fill_times, word_times, plans = {}, [], [], []
    for iteration in range(10):
        made = await editor.create(db, CreateDraft(requestId=f'scale-{iteration}', textbookId=1, title='合成规模教案'), USER)
        draft_id = made['draftId']
        for index, conditions in enumerate(filters):
            began = time.perf_counter()
            candidates = await editor.candidates(db, CandidateQuery(draftId=draft_id, filter=conditions), USER)
            filter_times.setdefault(str(index), []).append(time.perf_counter()-began)
            assert len(candidates['rows']) == 20 and candidates['total'] > 10000
        group = {'groupKey': 'g', 'name': '内容', 'catalogIds': [1],
                 'rules': [{'ruleKey': 'r', 'name': '基础练习', 'targetCount': 20, 'filter': {'questionTypes': ['单选题']}}]}
        await editor.command(db, draft_id, mutation(1, f'structure-{iteration}', type='set_structure', groups=[group]), USER)
        began = time.perf_counter()
        filled = await editor.select_by_rules(db, draft_id, Fill(requestId=f'fill-{iteration}', expectedRevision=2), USER)
        fill_times.append(time.perf_counter()-began)
        assert filled['allocationResults'][0]['added'] == 20
        began = time.perf_counter()
        model, paths = await editor.export_model(db, draft_id, 3, USER)
        payload = build_question_docx(model, lambda q, k: paths.get((q,k)))
        word_times.append(time.perf_counter()-began)
        assert payload.startswith(b'PK')
    # Verify the actual 200-item document limit with saved selections and export.
    for index, ids in enumerate((list(range(1000,1100)), list(range(1100,1180)))):
        await editor.command(db, draft_id, mutation(3+index, f'max-{index}', type='select', questionIds=ids, groupKey='g'), USER)
    view = await editor.detail(db, draft_id, USER)
    assert len(view['items']) == 200
    began = time.perf_counter()
    model, paths = await editor.export_model(db, draft_id, 5, USER)
    payload = build_question_docx(model, lambda q,k: paths.get((q,k)))
    maximum_word = (time.perf_counter()-began)*1000
    for conditions in filters:
        query = (await filtered_ids(db, 1, conditions)).order_by(QbQuestion.question_id.desc()).limit(20)
        sql = str(query.compile(dialect=db.bind.dialect, compile_kwargs={'literal_binds':True}))
        prefix = 'EXPLAIN ' if db.bind.dialect.name == 'mysql' else 'EXPLAIN QUERY PLAN '
        result = (await db.execute(text(prefix+sql))).mappings().all()
        plans.append({'sql':sql,'plan':[dict(row) for row in result]})
    output = {'dataset':{'syntheticQuestions':50000,'usableQuestions':50001,'assets':0,'draftLimit':200},
              'environment':{'platform':platform.platform(),'python':platform.python_version(),'database':db.bind.dialect.name},
              'filters':{key:distribution(values) for key,values in filter_times.items()},
              'fill20':distribution(fill_times), 'word20':distribution(word_times),
              'word200Ms':round(maximum_word,2),'word200Bytes':len(payload),
              'peakRssMiB':round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1024**2 if platform.system()=='Darwin' else 1024),2),
              'queryPlans':plans}
    destination = Path(os.getenv('LESSON_EDITOR_SCALE_REPORT','/tmp/lesson-editor-scale.json'))
    destination.write_text(json.dumps(output,ensure_ascii=False,indent=2,default=str))
    print(json.dumps({k:v for k,v in output.items() if k!='queryPlans'},ensure_ascii=False))
    assert all(distribution(times)['p95Ms'] <= 2000 for times in filter_times.values())
    assert distribution(fill_times)['p95Ms'] <= 5000
