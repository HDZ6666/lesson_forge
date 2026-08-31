from plugins.bank.service.catalog_progress import build_catalog_progress_tree

EXPECTED_CHAPTER_TOTAL = 9734
EXPECTED_CHAPTER_CRAWLED_UNIQUE = 3
EXPECTED_SECTION_CRAWLED_UNIQUE = 2
EXPECTED_LEAF_TOTAL = 90


def test_catalog_progress_rolls_up_unique_questions_and_keeps_node_totals() -> None:
    tree = build_catalog_progress_tree(
        [
            {'externalId': 'ch1', 'parentExternalId': None, 'level': 1, 'name': '第一章'},
            {'externalId': 's1', 'parentExternalId': 'ch1', 'level': 2, 'name': '第一节'},
            {'externalId': 'p1', 'parentExternalId': 's1', 'level': 3, 'name': '知识点A'},
            {'externalId': 'p2', 'parentExternalId': 's1', 'level': 3, 'name': '知识点B'},
        ],
        [
            {'catalogExternalId': 'ch1', 'questionExternalId': 'q1'},
            {'catalogExternalId': 'ch1', 'questionExternalId': 'q2'},
            {'catalogExternalId': 's1', 'questionExternalId': 'q1'},
            {'catalogExternalId': 'p1', 'questionExternalId': 'q1'},
            {'catalogExternalId': 'p2', 'questionExternalId': 'q3'},
        ],
        {
            'ch1': {'expectedTotal': 9734, 'expectedPages': 974, 'lastCompletedPage': 974},
            's1': {'expectedTotal': 100, 'expectedPages': 10, 'lastCompletedPage': 10},
            'p1': {'expectedTotal': 40, 'expectedPages': 4, 'lastCompletedPage': 4},
            'p2': {'expectedTotal': 90, 'expectedPages': 9, 'lastCompletedPage': 2},
        },
    )
    chapter = tree['catalogs'][0]
    assert chapter['expectedTotal'] == EXPECTED_CHAPTER_TOTAL
    assert chapter['crawledUnique'] == EXPECTED_CHAPTER_CRAWLED_UNIQUE
    assert chapter['children'][0]['crawledUnique'] == EXPECTED_SECTION_CRAWLED_UNIQUE
    assert chapter['children'][0]['children'][1]['expectedTotal'] == EXPECTED_LEAF_TOTAL
    assert tree['pagesTotal'] == 974 + 10 + 4 + 9
