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
//   baseURL       - SearXNG base URL            (default "http://127.0.0.1:8888")
//   timeoutMs     - per-search fetch budget     (default 10000)
//   language      - SearXNG `language` param    (default: omit, server default)
//   categories    - SearXNG `categories` param  (default: omit -> "general")
//   engines       - SearXNG `engines` param     (default: omit; wins over categories)
//   safesearch    - SearXNG `safesearch` param  (default: omit, server default)
//   promptSection - false disables the system-prompt awareness section
//   skill         - false disables the `searxng` skill registration

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'deepseek-harness-dsh-plugin-searxng/0.2.0';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8888';
const DEFAULT_TIMEOUT_MS = 10_000;

// The skill registry's standard precedence rank for packaged/bundled skills.
// Hardcoded rather than imported: @deepseek-ai/dsh-skill is not resolvable
// from an out-of-tree plugin (it is not a dependency of the profile), and a
// number survives that fine.
const BUNDLED_SKILL_RANK = 600;

export const name = 'searxng';
export const inject = ['web'];

export function apply(ctx, config = {}) {
  if (typeof ctx.web?.registerSearchProvider !== 'function') {
    console.error('[searxng] web seam has no registerSearchProvider; search provider skipped');
    return;
  }
  ctx.web.registerSearchProvider(new SearxngSearchProvider(config));
  // Awareness half: system-prompt section + skill. Optional services ride
  // scoped ctx.inject calls (same pattern as modsearch) so a minimal profile
  // without them keeps the search provider and skips these silently.
  if (typeof ctx.inject !== 'function') return;
  if (config.promptSection !== false) {
    ctx.inject(['tools', 'systemPrompt'], (scope) => {
      try {
        registerPromptSection(scope);
      } catch (error) {
        console.error(`[searxng] prompt section skipped: ${error}`);
      }
    });
  }
  if (config.skill !== false) {
    ctx.inject(['skills'], (scope) => {
      try {
        scope.skills.registerProvider(() => searxngSkillProvider);
      } catch (error) {
        console.error(`[searxng] skill registration skipped: ${error}`);
      }
    });
  }
}

/**
 * A short, always-present system-prompt section placed right after the web
 * tool guidance (TOOL_WEB_FETCH = 2100). This is what makes a fresh session
 * know the integration exists without probing: it names the instance, the
 * service unit, and the direct-API escape hatch, and defers details to the
 * `searxng` skill. Empty string in scopes where web_search is not visible —
 * the same visibility pattern the built-in web tools use for their sections.
 */
function registerPromptSection(scope) {
  const { tools, systemPrompt } = scope;
  if (typeof systemPrompt?.section !== 'function') return;
  systemPrompt.section({
    name: 'plugin:searxng-web-search',
    order: 2150,
    text: ({ scope: resolutionScope }) =>
      typeof tools?.get === 'function' && tools.get('web_search', resolutionScope) === undefined
        ? ''
        : PROMPT_SECTION_TEXT,
  });
}

const PROMPT_SECTION_TEXT =
  'web_search on this deployment is backed by a local SearXNG metasearch instance ' +
  '(default http://127.0.0.1:8888, no API key) through the "searxng" provider. If a ' +
  'search fails to connect, check that instance first with `systemctl --user status searxng` ' +
  'before hunting for ports or configuration elsewhere. For filtered or advanced searches ' +
  "web_search does not expose (categories, engines, date ranges, pagination), query the " +
  "instance's JSON API directly, e.g. " +
  "`curl -s 'http://127.0.0.1:8888/search?q=QUERY&format=json'`. The `searxng` skill has " +
  'the full API, service management, and troubleshooting details.';

/**
 * The `searxng` skill: the deeper operational knowledge a session can load on
 * demand. Registered the same way dsh's built-in badge skill registers its
 * own — a provider with list()/get() on ctx.skills — so it appears in every
 * session's skill catalog next to the other search providers' skills.
 */
const SKILL_BODY_URL = new URL('../skills/searxng/SKILL.md', import.meta.url);
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/searxng/', import.meta.url)),
};
const SKILL_CANDIDATE = {
  name: 'searxng',
  description:
    "Operate the local SearXNG metasearch instance that backs this deployment's web_search " +
    '(no API key). Load when web_search fails or returns nothing, when the user mentions ' +
    'SearXNG or asks how search is set up, or when a search needs filters web_search does ' +
    'not expose: categories, engine selection, date ranges, pagination.',
  invocation: {
    modelInvocable: true,
    userInvocable: true,
  },
  provider: 'searxng-plugin',
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
};
const searxngSkillProvider = {
  name: 'searxng-plugin',
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get() {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    };
  },
};

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
