from typing import Annotated, Literal

from pydantic import ConfigDict, Field, model_validator

from plugins.bank.entity.vo.bank_vo import BankModel

ID = Annotated[int, Field(gt=0)]
Key = Annotated[str, Field(min_length=1, max_length=64, pattern=r'^[a-zA-Z0-9_-]+$')]


class EditorModel(BankModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value.split('_')[0] + ''.join(s.title() for s in value.split('_')[1:]),
        populate_by_name=True,
        extra='forbid',
    )


class QuestionFilter(EditorModel):
    catalog_ids: list[ID] = Field(default_factory=list, max_length=100)
    question_types: list[str] = Field(default_factory=list, max_length=30)
    difficulties: list[str] = Field(default_factory=list, max_length=10)
    ease_min: float | None = Field(default=None, ge=0, le=1)
    ease_max: float | None = Field(default=None, ge=0, le=1)
    year_min: int | None = Field(default=None, ge=1900, le=2200)
    year_max: int | None = Field(default=None, ge=1900, le=2200)
    provinces: list[str] = Field(default_factory=list, max_length=50)
    cities: list[str] = Field(default_factory=list, max_length=100)
    exam_types: list[str] = Field(default_factory=list, max_length=50)
    max_extra_points: int | None = Field(default=None, ge=0, le=100)
    max_subquestion_count: int | None = Field(default=None, ge=1, le=100)
    allow_image: bool = True
    allow_table: bool = True

    @model_validator(mode='after')
    def ranges(self):
        if self.difficulties and (self.ease_min is not None or self.ease_max is not None):
            raise ValueError('难度标签和易度区间只能选择一种')
        for low, high in ((self.ease_min, self.ease_max), (self.year_min, self.year_max)):
            if low is not None and high is not None and low > high:
                raise ValueError('筛选下限不能超过上限')
        for name in ('catalog_ids', 'question_types', 'difficulties', 'provinces', 'cities', 'exam_types'):
            values = getattr(self, name)
            if any(isinstance(value, str) and (not value.strip() or len(value) > 100) for value in values):
                raise ValueError('筛选项不能为空或超过100字')
            setattr(self, name, list(dict.fromkeys(values)))
        return self


class Rule(EditorModel):
    rule_key: Key
    name: str = Field(default='条件组', max_length=100)
    target_count: int = Field(default=1, ge=0, le=20)
    filter: QuestionFilter = Field(default_factory=QuestionFilter)


class Group(EditorModel):
    group_key: Key
    name: str = Field(min_length=1, max_length=100)
    catalog_ids: list[ID] = Field(default_factory=list, max_length=100)
    rules: list[Rule] = Field(default_factory=list, max_length=40)


class PrintSettings(EditorModel):
    show_group_titles: bool = True
    blank_lines: Literal[0, 2, 4] = 2


class Mutation(EditorModel):
    request_id: Key
    expected_revision: int = Field(gt=0)


class CreateDraft(EditorModel):
    request_id: Key
    textbook_id: ID
    title: str = Field(default='新教案', min_length=1, max_length=200)


class CopyDraft(EditorModel):
    request_id: Key
    title: str | None = Field(default=None, min_length=1, max_length=200)


class Command(Mutation):
    type: Literal['set_title', 'set_structure', 'set_print', 'select', 'move', 'remove', 'undo', 'reorder']
    title: str | None = Field(default=None, min_length=1, max_length=200)
    groups: list[Group] | None = Field(default=None, max_length=40)
    print_settings: PrintSettings | None = None
    question_ids: list[ID] = Field(default_factory=list, max_length=100)
    item_ids: list[ID] = Field(default_factory=list, max_length=200)
    group_key: Key | None = None
    rule_key: Key | None = None
    undo_request_id: Key | None = None
    filter: QuestionFilter | None = None


class CandidateQuery(EditorModel):
    draft_id: ID
    rule_key: Key | None = None
    filter: QuestionFilter = Field(default_factory=QuestionFilter)
    page_num: int = Field(default=1, ge=1, le=100000)
    page_size: int = Field(default=20, ge=1, le=100)


class Pick(Mutation):
    count: int = Field(default=1, ge=1, le=20)
    group_key: Key | None = None
    filter: QuestionFilter = Field(default_factory=QuestionFilter)


class Fill(Mutation):
    group_key: Key | None = None
    rule_key: Key | None = None


class Replace(Mutation):
    filter: QuestionFilter | None = None


class Export(EditorModel):
    revision: int = Field(gt=0)
