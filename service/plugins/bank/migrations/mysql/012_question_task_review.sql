CREATE TABLE IF NOT EXISTS qb_question_task_review (
    task_id BIGINT NOT NULL PRIMARY KEY,
    baseline_json JSON NOT NULL,
    excluded_json JSON NOT NULL,
    revision INT NOT NULL DEFAULT 0,
    captured_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
