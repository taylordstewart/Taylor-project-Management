// Minimal Trello REST client with retry on rate limits (429) and transient 5xx errors.
// Auth goes in the Authorization header so the key/token never appear in URLs or logs.

const API = 'https://api.trello.com/1';
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTrelloClient({ key, token }) {
  if (!key || !token) throw new Error('TRELLO_API_KEY and TRELLO_API_TOKEN must both be set');
  const auth = `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`;
  let requestCount = 0;

  async function request(method, path, { query, body } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      requestCount++;
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        // Trello's limit is 100 requests / 10s per token; honor Retry-After when present.
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        console.warn(`[trello] ${method} ${path} -> ${res.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      const text = await res.text().catch(() => '');
      throw new Error(`Trello ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    get requestCount() {
      return requestCount;
    },
  };
}
