const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5000;

export class HttpError extends Error {
  constructor({ label, status, body }) {
    super(`${label} failed: ${status} ${JSON.stringify(body)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export async function fetchJsonWithRetry({
  url,
  options,
  label,
  retries = DEFAULT_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  fetchImpl = fetch,
  sleep = delay,
  onRetry = logRetry,
}) {
  return withRetry(
    async () => {
      const response = await fetchImpl(url, options);
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new HttpError({ label, status: response.status, body });
      }
      return { response, body };
    },
    {
      label,
      retries,
      baseDelayMs,
      maxDelayMs,
      shouldRetry: isRetryableError,
      sleep,
      onRetry,
    },
  );
}

export async function withRetry(
  operation,
  {
    label = 'operation',
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry = isRetryableError,
    sleep = delay,
    onRetry = logRetry,
  } = {},
) {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }

      attempt += 1;
      const delayMs = retryDelayMs({ attempt, baseDelayMs, maxDelayMs });
      if (onRetry) {
        onRetry({ label, attempt, retries, delayMs, error });
      }
      await sleep(delayMs);
    }
  }
}

export function isRetryableError(error) {
  if (error instanceof HttpError) return isRetryableStatus(error.status);
  return error?.name === 'TypeError' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET';
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function retryDelayMs({
  attempt,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
}) {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function logRetry({ label, attempt, retries, delayMs, error }) {
  console.warn(
    `[retry] ${label} attempt ${attempt}/${retries} in ${delayMs}ms: ${error.message}`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
