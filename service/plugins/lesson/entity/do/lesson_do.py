from sqlalchemy import CHAR, JSON, BigInteger, Column, DateTime, Index, Integer, Numeric, SmallInteger, String

from config.database import Base


class LpScheme(Base):
    __tablename__ = 'lp_scheme'
    __table_args__ = (
        Index('idx_lp_scheme_textbook', 'textbook_id'),
        {'comment': '教案抽题方案'},
    )

    scheme_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    scheme_name = Column(String(200), nullable=False)
    textbook_id = Column(BigInteger, nullable=False)
    lesson_type = Column(String(20), nullable=False, server_default='new')
    duration_minutes = Column(SmallInteger, nullable=False, server_default='45')
    recent_years = Column(SmallInteger, nullable=False, server_default='3')
    preferred_province = Column(String(50), nullable=True)
    preferred_city = Column(String(100), nullable=True)
    preferred_exam_types = Column(JSON, nullable=True)
    prefer_real_exam = Column(CHAR(1), nullable=False, server_default='Y')
    remark = Column(String(500), nullable=True)
    status = Column(CHAR(1), nullable=False, server_default='0')
    create_by = Column(String(64), nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_by = Column(String(64), nullable=True)
    update_time = Column(DateTime, nullable=False)


class LpPickRule(Base):
    __tablename__ = 'lp_pick_rule'
    __table_args__ = (
        Index('idx_lp_pick_rule_scheme', 'scheme_id', 'sort_no'),
        {'comment': '教案抽题规则'},
    )

    rule_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    scheme_id = Column(BigInteger, nullable=False)
    sort_no = Column(Integer, nullable=False, server_default='0')
    phase = Column(String(20), nullable=False)
    rule_name = Column(String(200), nullable=True)
    catalog_ids = Column(JSON, nullable=False)
    question_count = Column(SmallInteger, nullable=False, server_default='1')
    question_types = Column(JSON, nullable=True)
    ease_min = Column(Numeric(5, 4), nullable=True)
    ease_max = Column(Numeric(5, 4), nullable=True)
    max_extra_points = Column(SmallInteger, nullable=False, server_default='1')
    max_subquestion_count = Column(SmallInteger, nullable=True)
    allow_image = Column(CHAR(1), nullable=False, server_default='Y')
    allow_table = Column(CHAR(1), nullable=False, server_default='Y')
    create_time = Column(DateTime, nullable=False)


class LpGeneration(Base):
    __tablename__ = 'lp_generation'
    __table_args__ = (
        Index('idx_lp_generation_scheme', 'scheme_id'),
        Index('idx_lp_generation_create_time', 'create_time'),
        {'comment': '教案生成结果'},
    )

    generation_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    scheme_id = Column(BigInteger, nullable=False)
    seed = Column(BigInteger, nullable=False)
    status = Column(String(20), nullable=False, server_default='ready')
    rule_snapshot_json = Column(JSON, nullable=True)
    scheme_snapshot_json = Column(JSON, nullable=True)
    summary_json = Column(JSON, nullable=True)
    lesson_json = Column(JSON, nullable=True)
    create_by = Column(String(64), nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_by = Column(String(64), nullable=True)
    update_time = Column(DateTime, nullable=False)


class LpGenerationItem(Base):
    __tablename__ = 'lp_generation_item'
    __table_args__ = (
        Index('uk_lp_generation_question', 'generation_id', 'question_id', unique=True),
        Index('idx_lp_generation_item_rule', 'generation_id', 'rule_id', 'sort_no'),
        {'comment': '教案生成题目条目'},
    )

    item_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    generation_id = Column(BigInteger, nullable=False)
    rule_id = Column(BigInteger, nullable=False)
    phase = Column(String(20), nullable=False)
    sort_no = Column(Integer, nullable=False, server_default='0')
    question_id = Column(BigInteger, nullable=False)
    score = Column(Numeric(8, 3), nullable=True)
    relax_level = Column(SmallInteger, nullable=False, server_default='0')
    matched_catalog_ids = Column(JSON, nullable=True)
    evidence_type = Column(String(30), nullable=True)
    replaced_from_question_id = Column(BigInteger, nullable=True)
    question_snapshot_json = Column(JSON, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)
