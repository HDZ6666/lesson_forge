"""Validate sealed scan evidence without equating reported totals with gaps."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any

from exceptions.exception import ServiceException

FORMAT = 'run-coverage-v1'
COUNT_KEYS = {
    'availableCatalogCount', 'selectedCatalogCount', 'observedCatalogCount',
    'scanCompletedCatalogCount', 'dataCompletedCatalogCount', 'unscannedCatalogCount',
    'failedPageCount', 'duplicatePageCount', 'parseErrorCount', 'assetErrorCount',
    'startPage', 'maxPages', 'questionLimit',
}


def _count(value: Any) -> bool:
    return value is None or type(value) is int and 0 <= value <= 2**53 - 1


def normalise_run_coverage(value: Any, run_id: int, textbook_id: str, locked_at: datetime | None):
    if value is None:
        return None  # Older Collectors do not have this evidence; unknown is not zero.
    try:
        if (
            not isinstance(value, dict)
            or set(value) != {'format', 'collectorRunId', 'textbookExternalId', 'sourceReport', 'scan'}
            or value['format'] != FORMAT or type(value['collectorRunId']) is not int
            or value['collectorRunId'] != run_id or value['textbookExternalId'] != textbook_id
        ):
            raise ValueError
        source, scan = value['sourceReport'], value['scan']
        if (
            not isinstance(source, dict) or set(source) != {'count', 'observedAt', 'basis'}
            or not _count(source['count'])
            or source['basis'] != (None if source['count'] is None else 'textbook_root_probe')
            or source['count'] is None and source['observedAt'] is not None
            or not isinstance(scan, dict) or set(scan) != COUNT_KEYS | {'targetsKnown', 'catalogSelectionTruncated'}
            or not all(_count(scan[key]) for key in COUNT_KEYS)
            or type(scan['targetsKnown']) is not bool
            or scan['catalogSelectionTruncated'] is not None and type(scan['catalogSelectionTruncated']) is not bool
        ):
            raise ValueError
        observed = source['observedAt']
        if observed is not None:
            if not isinstance(observed, str) or len(observed) > 80:
                raise ValueError
            parsed = datetime.fromisoformat(observed.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError
            parsed = parsed.astimezone(timezone.utc)
            seal = locked_at.replace(tzinfo=timezone.utc) if locked_at and locked_at.tzinfo is None else locked_at
            if seal and parsed > seal:
                raise ValueError
            observed = parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        progress_count = scan['observedCatalogCount']
        for key in ('scanCompletedCatalogCount', 'dataCompletedCatalogCount'):
            if scan[key] is not None and (progress_count is None or scan[key] > progress_count):
                raise ValueError
        selected, complete, missing = (scan[key] for key in (
            'selectedCatalogCount', 'scanCompletedCatalogCount', 'unscannedCatalogCount',
        ))
        if scan['targetsKnown']:
            if selected is None or progress_count is not None and progress_count > selected:
                raise ValueError
            if missing != (None if complete is None else selected - complete):
                raise ValueError
        elif missing is not None:
            raise ValueError
        if scan['startPage'] == 0:
            raise ValueError
        return {**copy.deepcopy(value), 'sourceReport': {**source, 'observedAt': observed}}
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise ServiceException(message='封存的来源观察或扫描覆盖证据无效，请核对当前运行') from exc


def run_coverage_status(value: dict | None, question_count: int):
    if value is None:
        return None
    result = copy.deepcopy(value)
    count, scan = result['sourceReport']['count'], result['scan']
    result['collectedQuestionCount'] = question_count
    result['sourceCountDifference'] = None if count is None else count - question_count
    # The provider observation can predate collection and use different counts.
    # Only persisted failed/unscanned ranges are known gaps, never this difference.
    result['differenceIsExactGap'] = False
    result['hasKnownGaps'] = any((scan[key] or 0) > 0 for key in (
        'unscannedCatalogCount', 'failedPageCount', 'parseErrorCount', 'assetErrorCount',
    )) or scan['catalogSelectionTruncated'] is True or (scan['startPage'] or 1) > 1
    result['hasBudgetLimits'] = (scan['questionLimit'] or 0) > 0 or (scan['maxPages'] or 0) > 0
    return result
