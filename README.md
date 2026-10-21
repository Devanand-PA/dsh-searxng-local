# SearXNG (local) + DeepSeek Harness search plugin

A local-first web search stack: a SearXNG metasearch instance runs on your
machine as a systemd user service, and a small DeepSeek Harness (dsh) plugin
registers it as the `web_search` provider for every agent in the `web`
profile. No API keys, no third-party search accounts — queries go through
your own SearXNG, which fans out to Google, Brave, DuckDuckGo, and friends.

```
agent (web_search tool)
  └─ ctx.web seam ── searchProvider: searxng      ← pinned by the bundle patch
       └─ dsh-plugin-searxng (this repo = the plugin package)
            └─ http://127.0.0.1:8888/search?format=json
                 └─ SearXNG (systemd --user service, survives reboot via linger)
                      └─ google cse / brave / duckduckgo / wikipedia / ...
```

`web_fetch` is untouched: it keeps the built-in local HTTP fetch provider.

## Install the plugin

This repository **is** the plugin package (`dsh-plugin-searxng`): the repo
root carries `package.json` with the `dsh.bundle.patch` manifest, and the
plugin is plain ESM — no build step, so a git install works as-is.

### Option A — Plugins GUI (recommended)

DSH Web GUI → **Plugins** → **Install from source**, and enter:

```
github:Devanand-PA/dsh-searxng-local
```

(or `https://github.com/Devanand-PA/dsh-searxng-local.git`). Installation
adds the bundle and enables it by default; the plugin's patch row pins
`searchProvider: searxng` for the profile.

### Option B — CLI

```sh
dsh plugin --profile web add github:Devanand-PA/dsh-searxng-local
```

### Option C — profile `package.json`

```jsonc
{
  // …
  "dependencies": {
    "dsh-plugin-searxng": "github:Devanand-PA/dsh-searxng-local"
    // …or a local checkout, edit-in-place friendly:
    // "dsh-plugin-searxng": "link:/path/to/dsh-searxng-local"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …existing bundles…,
        "dsh-plugin-searxng"
      ]
    }
  }
}
```

Then `pnpm install` in the profile directory (or re-run `dsh plugin add`),
and restart DSH.

The plugin declares `dsh.compatibility` metadata (`dsh >= 0.2.1-rc.2`,
profiles `web` and `headless`) and requires no dsh peer dependencies, so the
plugin manager's version gate never blocks it.

## Repo layout

| path                                  | what it is                              |
| ------------------------------------- | --------------------------------------- |
| `package.json`, `cordis.patch.yml`    | the plugin package (bundle manifest)    |
| `dsh/index.js`                        | the plugin (dependency-free ESM)        |
| `skills/searxng/SKILL.md`             | the `searxng` skill body                |
| `test/provider-smoke.mjs`             | standalone smoke test                   |
| `deploy/settings-local.example.yml`   | SearXNG settings template               |
| `deploy/searxng.service`              | systemd `--user` unit template          |

## 1. Set up the SearXNG instance

The examples below use `~/sourced/searxng` as the checkout location — adjust
the paths in `deploy/searxng.service` if you clone elsewhere.

1. Shallow-clone upstream SearXNG and create a Python 3.13 venv with uv:

   ```sh
   git clone --depth 1 https://github.com/searxng/searxng ~/sourced/searxng
   cd ~/sourced/searxng
   uv venv --python 3.13 .venv
   uv pip install --python .venv/bin/python \
       -r requirements.txt -r requirements-server.txt
   ```

2. Copy the settings template next to the checkout and generate a secret key:

   ```sh
   cp <this-repo>/deploy/settings-local.example.yml ~/sourced/searxng/settings-local.yml
   python3 -c "import secrets; print(secrets.token_hex(32))"  # paste into secret_key
   ```

3. Install and start the user service from the unit template:

   ```sh
   cp <this-repo>/deploy/searxng.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now searxng
   loginctl enable-linger   # start at boot without root
   ```

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

## 2. The plugin — `dsh-plugin-searxng`

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
node test/provider-smoke.mjs
```

### What agents automatically know

The plugin also registers two awareness artifacts, so a fresh session knows
the integration exists without probing (opt out per deployment via the
`promptSection` / `skill` config flags):

- **A system-prompt section** (next to the built-in web-tool guidance) stating
  that `web_search` is backed by the local SearXNG instance, that a failing
  search should first be checked with `systemctl --user status searxng`, and
  that the JSON API is available for filtered queries.
- **A `searxng` skill** in every session's skill catalog (registered the same
  way dsh's built-in skills are), carrying the direct-API recipes, service
  management, and troubleshooting tables.

## 3. Routing

The package's `cordis.patch.yml` (bundle layer) mounts the plugin and pins
`searchProvider: searxng`. Bundle patches apply in profile-bundle order, so a
profile whose own `cordis.patch.yml` pins another provider in this deployment
should also pin searxng there (a patch row replaces the targeted row's whole
config):

```yaml
- id: web
  config:
    searchProvider: searxng
```

To fall back to another provider, delete that row (the running app hot-reloads
the file).

Inspect the effective composition at any time:

```sh
dsh --dump-config --profile web | grep -A3 '^# == dsh-plugin-searxng'
dsh --dump-config --profile web | grep -A3 '^- id: web$'
```

## Development (local checkout)

```sh
dsh plugin --profile web add /path/to/dsh-searxng-local   # link: dependency
node test/provider-smoke.mjs                              # provider + awareness tests
```

A `link:` install points the profile's `node_modules/dsh-plugin-searxng` at
this directory, so source edits apply on the next reload with no reinstall.
A full-fidelity composition check that needs no live app:

```sh
DSH_HOME=/tmp/dsh-verify dsh --dump-config --profile web | grep -A3 'dsh-plugin-searxng'
```

## Acknowledgements

- [SearXNG](https://github.com/searxng/searxng) — the metasearch engine,
  served with the granian invocation from its own `manage` script.
- Plugin API surface (`ctx.web.registerSearchProvider`, `dsh.bundle.patch`
  manifest, patch-row semantics): the `@deepseek-ai/dsh` packages;
  [`@liustack/modsearch`](https://www.npmjs.com/package/@liustack/modsearch)'s
  `dsh/index.js` served as the working reference for the out-of-tree plugin
  pattern.
- GitHub-installable bundle layout (`dsh.bundle` manifest, shipped plain JS,
  no prepare step): [dsh-opencode-zen-plugin](https://github.com/Devanand-PA/dsh-opencode-zen-plugin).
