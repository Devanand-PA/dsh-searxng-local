// DeepSeek Harness (dsh) plugin: routes the harness's web capability through a
// local SearXNG instance. dsh already owns a web seam (`ctx.web`) with a
// native `web_search` tool over pluggable providers, so this plugs in as a
// search provider instead of a competing tool: the model keeps the stable
// `web_search` schema and the UI keeps its citation cards, while the backend
// becomes the SearXNG instance running on this machine (default
// http://127.0.0.1:8888, JSON API enabled).
//
// Deliberately dependency-free (node builtins only): out-of-tree resolution of
// dsh's own packages is not yet reliable, and plain ESM needs no build step.
//
// Loaded via the cordis.patch.yml rows (see the package.json `dsh.bundle`
// manifest): one row mounts this plugin, one repoints the `web` seam's
// `searchProvider` at it.
//
// Config (set on this plugin's row in a patch file, e.g. the profile's
// cordis.patch.yml; every field optional):
//   baseURL     - SearXNG base URL            (default "http://127.0.0.1:8888")
//   timeoutMs   - per-search fetch budget     (default 10000)
//   language    - SearXNG `language` param    (default: omit, server default)
//   categories  - SearXNG `categories` param  (default: omit -> "general")
//   engines     - SearXNG `engines` param     (default: omit; wins over categories)
//   safesearch  - SearXNG `safesearch` param  (default: omit, server default)

const USER_AGENT = 'deepseek-harness-dsh-plugin-searxng/0.1.0';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8888';
const DEFAULT_TIMEOUT_MS = 10_000;

export const name = 'searxng';
export const inject = ['web'];

export function apply(ctx, config = {}) {
  if (typeof ctx.web?.registerSearchProvider !== 'function') {
    console.error('[searxng] web seam has no registerSearchProvider; search provider skipped');
    return;
  }
  ctx.web.registerSearchProvider(new SearxngSearchProvider(config));
}

/**
 * The SearXNG-backed search provider. `available()` must stay cheap and
 * offline: it only validates the configured base URL. An unreachable or
 * misconfigured instance is reported by `search()` as a descriptive error —
 * that beats an `available(): false` that would make the pinned provider look
 * absent.
 */
class SearxngSearchProvider {
  baseURL;
  timeoutMs;
  language;
  categories;
  engines;
  safesearch;

  constructor(config) {
    this.baseURL = typeof config.baseURL === 'string' && config.baseURL.trim() !== ''
      ? config.baseURL.trim()
      : DEFAULT_BASE_URL;
    this.timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.language = optString(config.language);
    this.categories = optString(config.categories);
    this.engines = optString(config.engines);
    this.safesearch = config.safesearch === 0 || config.safesearch === 1 || config.safesearch === 2
      ? String(config.safesearch)
      : undefined;
  }

  id = 'searxng';

  available() {
    try {
      const url = new URL(this.baseURL);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async search(request, signal) {
    const url = this.searchUrl(request.query);
    const response = await fetchJson(url, signal, this.timeoutMs);
    return normalizeResponse(response);
  }

  searchUrl(query) {
    const url = new URL('/search', ensureTrailingSlash(this.baseURL));
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    if (this.language !== undefined) url.searchParams.set('language', this.language);
    if (this.categories !== undefined) url.searchParams.set('categories', this.categories);
    if (this.engines !== undefined) url.searchParams.set('engines', this.engines);
    if (this.safesearch !== undefined) url.searchParams.set('safesearch', this.safesearch);
    return url;
  }
}

/** Validate one optional string config field; '' or non-string means omit. */
function optString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * GET the SearXNG JSON API once, under the caller's signal and the configured
 * budget, and parse the envelope. A non-2xx answer is a descriptive throw, so
 * the model-facing failure names the URL and the likely fix.
 */
async function fetchJson(url, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: merged,
    });
  } catch (error) {
    if (timedOut(timeout)) {
      throw new Error(
        `SearXNG at ${url.origin} did not answer within ${timeoutMs}ms. ` +
          'Check the instance: `systemctl --user status searxng`.',
        { cause: error },
      );
    }
    if (signal?.aborted) throw error;
    throw new Error(
      `SearXNG search request to ${url.origin} failed: ${String(error)}. ` +
        'Is the local instance running? Check: `systemctl --user status searxng`.',
      { cause: error },
    );
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.text();
      if (body.length > 0) detail = ` — ${body.trim().slice(0, 300)}`;
    } catch {
      // the status line is the error worth reporting
    }
    if (response.status === 403) {
      throw new Error(
        `SearXNG at ${url.origin} refused the JSON API (HTTP 403). ` +
          'Add "json" to search.formats in the instance settings (and restart searxng).',
      );
    }
    throw new Error(`SearXNG search failed (HTTP ${response.status})${detail}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`SearXNG at ${url.origin} returned a non-JSON body`, { cause: error });
  }
}

/** Whether the configured budget (not the caller) fired. */
function timedOut(timeoutSignal) {
  return timeoutSignal.aborted;
}

/**
 * Map a SearXNG JSON envelope to the web seam's normalized search result:
 * citeable `sources` first, plus a short model-facing summary (answer box,
 * related searches, and unresponsive engines) as `content` when present.
 */
function normalizeResponse(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const sources = [];
  const seen = new Set();
  for (const result of results) {
    if (typeof result?.url !== 'string' || result.url === '' || seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({
      url: result.url,
      ...(typeof result.title === 'string' && result.title !== '' ? { title: result.title } : {}),
      ...(typeof result.content === 'string' && result.content !== ''
        ? { snippet: result.content }
        : {}),
      ...(typeof result.publishedDate === 'string' && result.publishedDate !== ''
        ? { publishedAt: result.publishedDate }
        : {}),
    });
  }
  const summary = summarize(data, sources.length);
  return {
    ...(summary === undefined ? {} : { content: summary }),
    sources,
    // The seam re-caps against request.maxResults regardless.
    truncated: false,
  };
}

/** One short summary block; omitted when there is nothing to say. */
function summarize(data, count) {
  const lines = [];
  const engines = [
    ...new Set(
      (Array.isArray(data?.results) ? data.results : [])
        .map((result) => (typeof result?.engine === 'string' ? result.engine : ''))
        .filter((engine) => engine !== ''),
    ),
  ];
  if (count > 0) {
    lines.push(
      `Local SearXNG returned ${count} result${count === 1 ? '' : 's'}` +
        `${engines.length > 0 ? ` via ${engines.join(', ')}` : ''}.`,
    );
  }
  const answers = (Array.isArray(data?.answers) ? data.answers : [])
    .map((answer) => (typeof answer === 'string' ? answer.trim() : ''))
    .filter((answer) => answer !== '');
  for (const answer of answers.slice(0, 3)) lines.push(`Answer: ${answer}`);
  const suggestions = (Array.isArray(data?.suggestions) ? data.suggestions : [])
    .map((suggestion) => (typeof suggestion === 'string' ? suggestion.trim() : ''))
    .filter((suggestion) => suggestion !== '');
  if (suggestions.length > 0) lines.push(`Related searches: ${suggestions.slice(0, 6).join('; ')}`);
  const unresponsive = (Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : [])
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .filter((entry) => entry !== '');
  if (unresponsive.length > 0) lines.push(`Engines unresponsive: ${unresponsive.join('; ')}`);
  if (count === 0 && unresponsive.length === 0 && lines.length === 0) return undefined;
  return lines.join('\n');
}
