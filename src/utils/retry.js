'use strict';

/**
 * Executes an async operation with exponential backoff retry.
 * Only retries on network errors or 5xx server errors (HTTP errors never retry).
 *
 * @param {Function} fn async function returning a promise
 * @param {object} [options]
 * @param {number} [options.retries=2]
 * @param {number} [options.delayMs=500]
 * @param {number} [options.backoffFactor=2]
 * @param {Function} [options.shouldRetry] (err) => boolean
 */
async function withRetry(fn, options = {}) {
  const {
    retries = 2,
    delayMs = 500,
    backoffFactor = 2,
    shouldRetry = (err) => {
      if (!err.response) return true;
      const status = err.response.status;
      return status >= 500 && status <= 599;
    }
  } = options;
  let attempt = 0;
  let currentDelay = delayMs;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !shouldRetry(err)) {
        throw err;
      }
      await new Promise((res) => setTimeout(res, currentDelay));
      currentDelay *= backoffFactor;
    }
  }
}

module.exports = { withRetry };
