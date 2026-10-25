// Network retry helpers. Flaky mobile connections drop large binary requests
// (GLB/WebP/HDR/WAV) at a steady rate, and several loaders cache their
// promise FOREVER — one dropped request used to brick every later car load
// ("the car model doesn't load, the car turns invisible") until a full page
// reload. Every gameplay-critical asset load now retries with backoff, and
// failed promise caches reset so a later attempt can succeed.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function withRetry(task, { attempts = 3, baseDelayMs = 400, label = 'asset' } = {}) {
  return (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    // Keep the original message; the label only aids reporting.
    if (lastError instanceof Error && label) {
      lastError.message = `${lastError.message} (${label}, ${attempts} attempts)`;
    }
    throw lastError;
  })();
}

export function fetchWithRetry(url, options = {}, retry = {}) {
  return withRetry(() => fetch(url, options), retry);
}

// GLTF/texture loads: a fresh loader instance per attempt keeps each try
// independent of any partial parse state left by a failed download.
export function loadWithRetry(makeLoader, url, retry = {}) {
  return withRetry(() => makeLoader().loadAsync(url), retry);
}
