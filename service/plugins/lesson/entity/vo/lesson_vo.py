"""教案生成插件的请求与响应模型。字段对外 camelCase，对内 snake_case。"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

LessonType = Literal['new', 'practice', 'review']
Phase = Literal['intro', 'example', 'practice', 'extend', 'homework']
PageNumber = Annotated[int, Field(ge=1, le=100000)]
PageSize = Annotated[int, Field(ge=1, le=100)]
MAX_RULES = 40
MAX_CATALOGS_PER_RULE = 50
MAX_QUESTION_TYPES = 20
MAX_QUESTIONS_PER_RULE = 20


class LessonModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)


def _clean_text_list(values: list[str] | None, limit: int, label: str) -> list[str]:
    cleaned: list[str] = []
    for value in values or []:
        text = str(value).strip()
        if text and text not in cleaned:
            cleaned.append(text)
    if len(cleaned) > limit:
        raise ValueError(f'{label}最多 {limit} 项')
    return cleaned


class RuleInputModel(LessonModel):
    rule_id: int | None = Field(default=None, description='已保存规则主键，仅回显用')
    phase: Phase = Field(description='教学环节')
    rule_name: str | None = Field(default=None, max_length=200, description='规则名称')
    catalog_ids: list[int] = Field(min_length=1, description='知识点目录主键列表')
    question_count: int = Field(default=1, ge=1, le=MAX_QUESTIONS_PER_RULE, description='需要题数')
    question_types: list[str] = Field(default_factory=list, description='允许题型，空为不限')
    ease_min: float | None = Field(default=None, ge=0, le=1, description='易度系数下限')
    ease_max: float | None = Field(default=None, ge=0, le=1, description='易度系数上限')
    max_extra_points: int = Field(default=1, ge=0, le=10, description='允许额外知识点数')
    max_subquestion_count: int | None = Field(default=None, ge=1, le=50, description='最大小问数')
    allow_image: bool = Field(default=True, description='允许含图')
    allow_table: bool = Field(default=True, description='允许含表格')
    sort_no: int | None = Field(default=None, ge=0, description='规则顺序')

    @field_validator('catalog_ids')
    @classmethod
    def validate_catalog_ids(cls, value: list[int]) -> list[int]:
        ids: list[int] = []
        for item in value:
            if int(item) <= 0:
                raise ValueError('知识点主键必须是正整数')
            if int(item) not in ids:
                ids.append(int(item))
        if len(ids) > MAX_CATALOGS_PER_RULE:
            raise ValueError(f'单条规则最多 {MAX_CATALOGS_PER_RULE} 个知识点')
        return ids

    @field_validator('question_types')
    @classmethod
    def validate_question_types(cls, value: list[str]) -> list[str]:
        return _clean_text_list(value, MAX_QUESTION_TYPES, '题型')

    @model_validator(mode='after')
    def validate_ease_range(self) -> RuleInputModel:
        if self.ease_min is not None and self.ease_max is not None and self.ease_min > self.ease_max:
            raise ValueError('易度下限不能大于上限')
        return self


class LessonTextModel(LessonModel):
    objectives: str = Field(default='', max_length=4000, description='教学目标')
    key_points: str = Field(default='', max_length=2000, description='教学重点')
    difficult_points: str = Field(default='', max_length=2000, description='教学难点')
    process: str = Field(default='', max_length=6000, description='教学过程说明')
    board_notes: str = Field(default='', max_length=2000, description='板书要点')
    homework_note: str = Field(default='', max_length=2000, description='作业说明')


class SchemeInputModel(LessonModel):
    scheme_name: str | None = Field(default=None, max_length=200, description='方案名称，默认取课题')
    title: str | None = Field(default=None, max_length=200, description='教案课题')
    textbook_id: int = Field(gt=0, description='教材主键')
    lesson_type: LessonType = Field(default='new', description='课型')
    duration_minutes: int = Field(default=45, ge=10, le=240, description='课时长度')
    recent_years: int = Field(default=3, ge=0, le=30, description='近几年题目优先')
    preferred_province: str | None = Field(default=None, max_length=50, description='偏好省份')
    preferred_city: str | None = Field(default=None, max_length=100, description='偏好城市')
    preferred_exam_types: list[str] = Field(default_factory=list, description='偏好考试类型')
    prefer_real_exam: bool = Field(default=True, description='真题名校优先')
    remark: str | None = Field(default=None, max_length=500, description='备注')
    rules: list[RuleInputModel] = Field(min_length=1, max_length=MAX_RULES, description='抽题规则')
    seed: int | None = Field(default=None, ge=0, le=2**53, description='随机种子，空则随机')
    text: LessonTextModel | None = Field(default=None, description='文字部分初稿，空则按模板生成')

    @field_validator('preferred_exam_types')
    @classmethod
    def validate_exam_types(cls, value: list[str]) -> list[str]:
        return _clean_text_list(value, MAX_QUESTION_TYPES, '考试类型')


class SimulateRequestModel(LessonModel):
    textbook_id: int = Field(gt=0, description='教材主键')
    rules: list[RuleInputModel] = Field(min_length=1, max_length=MAX_RULES, description='抽题规则')


class DefaultRulesRequestModel(LessonModel):
    lesson_type: LessonType = Field(default='new', description='课型')
    catalog_ids: list[int] = Field(min_length=1, max_length=MAX_CATALOGS_PER_RULE, description='知识点目录主键')


class TextUpdateModel(LessonModel):
    title: str = Field(min_length=1, max_length=200, description='教案课题')
    text: LessonTextModel = Field(description='文字部分')


class GenerationPageQueryModel(LessonModel):
    page_num: PageNumber = Field(default=1, description='页码')
    page_size: PageSize = Field(default=10, description='每页数量')
    textbook_id: int | None = Field(default=None, gt=0, description='教材主键')
    keyword: str | None = Field(default=None, max_length=100, description='课题关键字')


class RuleSimulationModel(LessonModel):
    rule_index: int = Field(description='规则在请求中的序号')
    phase: str
    rule_name: str | None = None
    question_count: int
    candidate_counts: list[int] = Field(description='0~3 级放宽下的候选题数')
    satisfied_level: int | None = Field(default=None, description='首个满足题数的放宽级别，空为不足')
    message: str = Field(default='')


class RuleSummaryModel(LessonModel):
    rule_id: int
    phase: str
    rule_name: str | None = None
    needed: int
    picked: int
    max_relax_level: int
    short: bool
    message: str = ''


class QuestionAssetRefModel(LessonModel):
    asset_key: str
    asset_type: str | None = None
    mime_type: str | None = None
    download_status: str | None = None
    available: bool = False


class GenerationQuestionModel(LessonModel):
    question_id: int
    question_type: str | None = None
    difficulty: str | None = None
    difficulty_coefficient: float | None = None
    year: int | None = None
    province: str | None = None
    city: str | None = None
    exam_type: str | None = None
    paper_name: str | None = None
    source_text: str | None = None
    subquestion_count: int | None = None
    answer_status: str | None = None
    content_html: str | None = None
    plain_text: str | None = None
    answer_html: str | None = None
    analysis_html: str | None = None
    assets: list[QuestionAssetRefModel] = Field(default_factory=list)


class GenerationItemModel(LessonModel):
    item_id: int
    rule_id: int
    phase: str
    sort_no: int
    question_id: int
    score: float | None = None
    relax_level: int = 0
    matched_catalog_ids: list[int] = Field(default_factory=list)
    evidence_type: str | None = None
    replaced_from_question_id: int | None = None
    question: GenerationQuestionModel | None = None


class GenerationPhaseModel(LessonModel):
    phase: str
    name: str
    items: list[GenerationItemModel] = Field(default_factory=list)


class GenerationSummaryRowModel(LessonModel):
    generation_id: int
    scheme_id: int
    scheme_name: str | None = None
    title: str | None = None
    textbook_id: int | None = None
    textbook_name: str | None = None
    lesson_type: str | None = None
    seed: int | None = None
    status: str | None = None
    item_count: int = 0
    create_by: str | None = None
    create_time: datetime | None = None


class GenerationDetailModel(LessonModel):
    generation_id: int
    scheme_id: int
    seed: int
    status: str
    scheme: dict[str, Any]
    rules: list[dict[str, Any]]
    summary: list[RuleSummaryModel]
    lesson: dict[str, Any]
    phases: list[GenerationPhaseModel]
    create_by: str | None = None
    create_time: datetime | None = None
    update_time: datetime | None = None
