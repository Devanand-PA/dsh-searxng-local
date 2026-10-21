# SearXNG (local) + DeepSeek Harness search plugin

A local-first web search stack: a SearXNG metasearch instance runs on this
machine as a systemd user service, and a small DeepSeek Harness (dsh) plugin
registers it as the `web_search` provider for every agent in the `web`
profile. No API keys, no third-party search accounts — queries go through
your own SearXNG, which fans out to Google, Brave, DuckDuckGo, and friends.

```
agent (web_search tool)
  └─ ctx.web seam ── searchProvider: searxng      ← pinned in cordis.patch.yml
       └─ dsh-plugin-searxng (this repo, symlinked into the profile)
            └─ http://127.0.0.1:8888/search?format=json
                 └─ SearXNG (systemd --user service, survives reboot via linger)
                      └─ google cse / brave / duckduckgo / wikipedia / ...
```

`web_fetch` is untouched: it keeps the built-in local HTTP fetch provider.

## Components

### 1. SearXNG instance — `/home/devanandpa/sourced/searxng`

- Shallow clone of https://github.com/searxng/searxng, Python 3.13 venv
  created and populated with uv (`requirements.txt` + `requirements-server.txt`,
  served by granian).
- Settings: `settings-local.yml` next to the clone (`use_default_settings: true`,
  JSON format enabled, `127.0.0.1:8888`, limiter off, generated secret key).
- Service: `~/.config/systemd/user/searxng.service` (enabled; user lingering is
  on, so it starts at boot without root).

Manage it with:

```sh
systemctl --user status searxng        # is it up?
systemctl --user restart searxng       # after editing settings-local.yml
journalctl --user -u searxng -f        # logs
```

Verify the JSON API directly:

```sh
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 400
```

Update later with `git -C ~/sourced/searxng pull` and
`uv pip install --python ~/sourced/searxng/.venv/bin/python -r requirements.txt -r requirements-server.txt`,
then restart the service.

### 2. The plugin — `dsh-plugin-searxng/` (this directory)

Dependency-free ESM (`dsh/index.js`, node builtins only; no build step). It
registers one search provider on the `web` seam:

- `id: "searxng"`, cheap offline `available()` (URL-shape check only).
- `search({ query, maxResults }, signal)` calls the SearXNG JSON API and maps
  results to the seam's source shape (`url`, `title`, `snippet`, `publishedAt`),
  deduplicated in result order. The seam caps sources at `maxResults` itself.
- `content` carries a short summary: result count + engines, answer boxes,
  related searches, and unresponsive engines — that line
  ("Local SearXNG returned N results …") is the tell that a result came
  through this provider.
- Failures are descriptive and model-actionable: unreachable instance mentions
  `systemctl --user status searxng`; HTTP 403 points at the missing
  `search.formats: [html, json]` setting; the configured timeout is
  distinguishable from caller cancellation.

Config (all optional, set on the plugin's row in a patch file):

| field        | default                   | meaning                          |
| ------------ | ------------------------- | -------------------------------- |
| `baseURL`    | `http://127.0.0.1:8888`   | SearXNG base URL                 |
| `timeoutMs`  | `10000`                   | per-search fetch budget          |
| `language`   | *(server default)*        | SearXNG `language` param         |
| `categories` | *(server default: general)* | SearXNG `categories` param    |
| `engines`    | *(server default)*        | SearXNG `engines` param (overrides categories) |
| `safesearch` | *(server default)*        | `0` / `1` / `2`                  |

Test it standalone (against the live instance):

```sh
cd dsh-plugin-searxng && node test/provider-smoke.mjs
```

### 3. Wiring into the `web` profile

Already done:

1. `dsh plugin --profile web add <this dir>` installed the package
   (`link:` dependency — `~/.dsh/profiles/web/node_modules/dsh-plugin-searxng`
   is a symlink to this directory, so source edits apply on the next reload,
   no reinstall) and appended `dsh-plugin-searxng` to
   `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`.
2. The package's `cordis.patch.yml` (bundle layer) mounts the plugin and pins
   `searchProvider: searxng`.
3. `~/.dsh/profiles/web/cordis.patch.yml` (user layer, applied after every
   bundle) pins `searchProvider: searxng` again, so the routing wins
   regardless of bundle order. A patch row replaces the targeted row's whole
   config — **to fall back to modsearch, delete that `- id: web` row** (the
   running app hot-reloads the file).

The running app recomposed live when the files changed (dsh-hmr watches the
profile's `package.json` and `cordis.patch.yml`); no restart was needed. After
a fresh install elsewhere, a restart of DSH applies the same result.

Inspect the effective composition at any time:

```sh
dsh --dump-config --profile web | grep -A3 '^# == dsh-plugin-searxng'
dsh --dump-config --profile web | grep -A3 '^- id: web$'
```

## Provenance of this setup

- SearXNG: upstream master (shallow clone), served with the documented
  granian invocation from SearXNG's own `manage` script.
- Plugin API surface (`ctx.web.registerSearchProvider`, `dsh.bundle.patch`
  manifest, patch-row semantics): the installed `@deepseek-ai/dsh` 0.2.1-rc.2
  packages; `@liustack/modsearch`'s `dsh/index.js` served as the working
  reference for the out-of-tree plugin pattern.
