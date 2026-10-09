CREATE TABLE IF NOT EXISTS qb_question_import_intake (
    intake_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL,
    scope_id BIGINT NOT NULL,
    collector_run_id BIGINT NOT NULL,
    binding_hash CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    attempt_limit INT NOT NULL DEFAULT 3,
    next_attempt_at DATETIME NULL,
    worker_token CHAR(64) NULL,
    lease_until DATETIME NULL,
    error_kind VARCHAR(32) NULL,
    error_message VARCHAR(2000) NULL,
    import_id BIGINT NULL,
    create_time DATETIME NOT NULL,
    update_time DATETIME NOT NULL,
    UNIQUE KEY uk_qb_import_intake_scope_run (scope_id, collector_run_id),
    KEY idx_qb_import_intake_due (status, next_attempt_at, lease_until),
    KEY idx_qb_import_intake_task (task_id, intake_id),
    CONSTRAINT chk_qb_import_intake_status CHECK (
        status IN ('pending','probing','retry','ready','blocked','discarded')
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
