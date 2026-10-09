"""Subject registration and server-owned source profiles.

Registering a subject does not make an unverified collector adapter executable.
Profiles are immutable; client URLs/commands never select the source adapter.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbSubject
from plugins.bank.entity.vo.bank_vo import SubjectModel

SOURCE_PROFILES = {
    'zujuan_czsx': {
        'stageCode': 'junior',
        'subjectCode': 'math',
        'name': '组卷网 · 初中数学',
        'sourceProvider': 'zujuan',
        'bankPath': 'czsx',
        'bankId': 2,
    },
}


class SubjectService:
    @staticmethod
    def dump(row):
        value = SubjectModel.model_validate(row).model_dump(by_alias=True)
        value['syncSupported'] = row.source_profile in SOURCE_PROFILES
        return value

    @classmethod
    async def list(cls, db, include_disabled=False):
        query = select(QbSubject)
        if not include_disabled:
            query = query.where(QbSubject.status == '0')
        rows = (await db.execute(query.order_by(QbSubject.sort_order, QbSubject.subject_id))).scalars().all()
        return [cls.dump(row) for row in rows]

    @staticmethod
    async def require(db, subject_id, *, sync=False):
        row = await db.get(QbSubject, subject_id)
        if row is None or row.status != '0':
            raise ServiceException(message='所属学科不存在或已停用')
        if sync and row.source_profile not in SOURCE_PROFILES:
            raise ServiceException(message='该学科的采集适配尚未验证，暂不能启动同步')
        return row

    @classmethod
    async def save(cls, db, payload, *, editing=False):
        values = payload.model_dump(exclude={'subject_id'})
        values['subject_name'] = values['subject_name'].strip()
        values['source_profile'] = values['source_profile'] or None
        if not values['subject_name']:
            raise ServiceException(message='学科名称不能为空')
        profile = SOURCE_PROFILES.get(values['source_profile'])
        if values['source_profile'] and (
            not profile
            or profile['stageCode'] != values['stage_code']
            or profile['subjectCode'] != values['subject_code']
        ):
            raise ServiceException(message='来源映射必须使用与学段学科一致的已验证适配')
        if editing:
            row = await db.get(QbSubject, payload.subject_id or 0)
            if row is None:
                raise ServiceException(message='学科不存在')
            if any(getattr(row, key) != values[key] for key in ('stage_code', 'subject_code', 'source_profile')):
                raise ServiceException(message='学段、学科编码和来源映射不能修改，请新建学科')
            for key, value in values.items():
                setattr(row, key, value)
            row.update_time = datetime.now()
        else:
            row = QbSubject(**values, create_time=datetime.now(), update_time=datetime.now())
            db.add(row)
        try:
            await db.commit()
            await db.refresh(row)
        except IntegrityError as exc:
            await db.rollback()
            raise ServiceException(message='学段学科或来源映射已经存在') from exc
        return cls.dump(row)
