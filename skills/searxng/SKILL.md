---
name: searxng
description: >-
  Operate the local SearXNG metasearch instance that backs this deployment's
  web_search (no API key). Load when web_search fails or returns nothing, when
  the user mentions SearXNG or asks how search is set up, or when a search
  needs filters web_search does not expose: categories, engine selection,
  date ranges, pagination.
---

# Local SearXNG instance

This deployment routes its `web_search` tool through a **local SearXNG
metasearch instance** via the `searxng` provider (the `dsh-plugin-searxng`
plugin). It needs no API key, and every `web_search` call already goes
through it — you do not need to discover or configure anything to search.

Default base URL: `http://127.0.0.1:8888`. Confirm the actual URL, checkout
location, and settings path at any time with:

```sh
systemctl --user cat searxng
```

(The unit shows `GRANIAN_PORT`, `GRANIAN_HOST`, `SEARXNG_SETTINGS_PATH`, and
the SearXNG checkout directory.)

## Query the JSON API directly

`web_search` sends plain queries only. For everything else, call SearXNG's
JSON API yourself (e.g. via `curl` or a small script):

```sh
# Basic search
curl -s 'http://127.0.0.1:8888/search?q=QUERY&format=json'

# Restrict to a category (general, it, news, science, images, videos, ...)
curl -s 'http://127.0.0.1:8888/search?q=QUERY&format=json&categories=news'

# Pin engines (comma-separated; overrides categories)
curl -s 'http://127.0.0.1:8888/search?q=QUERY&format=json&engines=duckduckgo,brave'

# Other useful parameters
#   language=en          safesearch=0|1|2          pageno=2
#   time_range=day|week|month|year
```

The response is JSON: `results[]` items carry `url`, `title`, `content`
(snippet), `publishedDate`, and `engine`; `answers[]` holds instant answers,
`suggestions[]` related searches, and `unresponsive_engines[]` engines that
failed for this query. Cite result URLs as markdown links.

## Manage the service

```sh
systemctl --user status searxng      # is it up?
systemctl --user restart searxng     # after config changes
journalctl --user -u searxng -f      # live logs
```

The service is a systemd **user** unit (enabled with lingering, so it starts
at boot without root).

## Troubleshooting

| symptom | cause and fix |
| --- | --- |
| search errors mention `systemctl --user status searxng` | instance down or unreachable — check the service, then the URL/port |
| HTTP 403 from the search endpoint | the instance's settings do not list `json` under `search.formats` — edit the settings file shown by `systemctl --user cat searxng` (`SEARXNG_SETTINGS_PATH`), add `json`, restart |
| timeouts on every search | upstream engines slow — raise the plugin's `timeoutMs` (config below), or check `unresponsive_engines` in a direct API response |
| results missing a category you expected | the category needs enabling in the instance settings; use `engines=` to pin specific engines instead |

## Tune the integration

The plugin reads optional config from its row in the profile's patch file
(`~/.dsh/profiles/<profile>/cordis.patch.yml`): `baseURL`, `timeoutMs`,
`language`, `categories`, `engines`, `safesearch`. Editing the profile patch
hot-reloads in the running app. Full setup documentation lives in the
`dsh-plugin-searxng` repository (including `deploy/` templates for recreating
this stack on another machine).
