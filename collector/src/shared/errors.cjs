'use strict';

/**
 * Error classes shared by every collector entry point.
 *
 * `StopCrawlError` means the crawl must stop for a source-side reason
 * (protection page, robots, unauthorized host).  `QuestionSyncError` carries a
 * machine-readable `code` consumed by the API manager and by resume logic.
 */
class StopCrawlError extends Error {
  constructor(message, code = 'blocked') {
    super(message);
    this.name = 'StopCrawlError';
    this.code = code;
  }
}

class QuestionSyncError extends Error {
  constructor(message, code = 'question_sync_error', details = null) {
    super(message);
    this.name = 'QuestionSyncError';
    this.code = code;
    this.details = details;
  }
}

class VerificationRequiredError extends QuestionSyncError {
  constructor(message, details = null) {
    super(message, 'waiting_verification', details);
    this.name = 'VerificationRequiredError';
  }
}

module.exports = {
  QuestionSyncError,
  StopCrawlError,
  VerificationRequiredError,
};
