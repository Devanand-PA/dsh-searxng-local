// Smoke test for the searxng search provider + awareness (prompt section,
// skill) against the local instance.
// Run: node test/provider-smoke.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply, name as pluginName } from '../dsh/index.js';

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function captureProvider(config) {
  let captured;
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        captured = provider;
      },
    },
  };
  apply(ctx, config);
  assert.ok(captured, 'apply() must register a search provider');
  return captured;
}

// 1. default registration shape
const provider = captureProvider({});
assert.equal(provider.id, 'searxng');
assert.equal(provider.available(), true, 'default baseURL must be available');

// 2. bad baseURL -> unavailable
assert.equal(captureProvider({ baseURL: 'not a url' }).available(), false, 'junk baseURL must be unavailable');

// 3. live search through the local instance
const result = await provider.search({ query: 'arch linux systemd user service', maxResults: 8 }, undefined);
assert.ok(Array.isArray(result.sources), 'sources must be an array');
assert.ok(result.sources.length > 0, 'expected at least one result');
for (const source of result.sources) {
  assert.equal(typeof source.url, 'string');
  assert.ok(source.url.startsWith('http'));
}
console.log(`live search: ${result.sources.length} sources (seam-capped at 8 -> ${result.sources.slice(0, 8).length})`);
console.log('content summary:\n' + (result.content ?? '(none)'));
console.log('first source:', JSON.stringify(result.sources[0], null, 2));

// 4. searchUrl honors config
const custom = captureProvider({
  baseURL: 'http://127.0.0.1:8888/',
  language: 'en',
  categories: 'it',
  engines: '',
  safesearch: 1,
  timeoutMs: 5000,
});
const customUrl = custom.searchUrl('test query');
assert.equal(customUrl.toString(), 'http://127.0.0.1:8888/search?q=test+query&format=json&language=en&categories=it&safesearch=1');
assert.equal(custom.available(), true);

// 5. unreachable instance -> descriptive error mentioning the service
const dead = captureProvider({ baseURL: 'http://127.0.0.1:9', timeoutMs: 1500 });
await assert.rejects(
  () => dead.search({ query: 'x' }, undefined),
  (error) => error.message.includes('systemctl --user status searxng'),
  'unreachable instance must produce a descriptive error',
);
console.log('unreachable-instance error OK:', (await dead.search({ query: 'x' }).catch((e) => e)).message.slice(0, 120));

// 6. caller cancellation is honored (AbortController aborted up front)
const abort = new AbortController();
abort.abort();
await assert.rejects(() => provider.search({ query: 'x' }, abort.signal));
console.log('caller-cancel path OK');

// 7. awareness: ctx without an inject function must not crash
const bareCtx = { web: { registerSearchProvider() {} } };
apply(bareCtx, {});
console.log('bare-ctx apply OK (no awareness services)');

// 8. awareness: skill + prompt section register through ctx.inject
function makeInjectingCtx({ withWebSearchTool }) {
  const registered = { skills: [], sections: [] };
  const tools = {
    get: (toolName) => (withWebSearchTool && toolName === 'web_search' ? { name: 'web_search' } : undefined),
  };
  const systemPrompt = {
    section(section) {
      registered.sections.push(section);
    },
  };
  const skills = {
    registerProvider(factory) {
      registered.skills.push(factory());
    },
  };
  const ctx = {
    web: { registerSearchProvider() {} },
    inject(names, cb) {
      const scope = {};
      if (names.includes('tools')) scope.tools = tools;
      if (names.includes('systemPrompt')) scope.systemPrompt = systemPrompt;
      if (names.includes('skills')) scope.skills = skills;
      cb(scope);
    },
  };
  return { registered, ctx };
}

{
  const { registered, ctx } = makeInjectingCtx({ withWebSearchTool: true });
  apply(ctx, {});
  assert.equal(registered.skills.length, 1, 'one skill provider expected');
  const skillProvider = registered.skills[0];
  assert.match(skillProvider.name, SKILL_NAME_RE);
  assert.equal(skillProvider.name, 'searxng-plugin');
  const candidates = await skillProvider.list();
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  // Mirror the registry's validateCandidate constraints.
  assert.match(candidate.name, SKILL_NAME_RE);
  assert.equal(typeof candidate.description, 'string');
  assert.ok(candidate.description.length > 0, 'candidate description must be non-empty');
  assert.equal(candidate.provider, skillProvider.name, 'candidate.provider must name its provider');
  assert.equal(typeof candidate.rank, 'number');
  assert.ok(Number.isFinite(candidate.rank));
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
  const definition = await skillProvider.get(candidate);
  assert.equal(definition.name, candidate.name);
  assert.equal(typeof definition.content, 'string');
  assert.ok(definition.content.includes('# Local SearXNG instance'), 'skill body must be the SKILL.md');
  const bodyOnDisk = await readFile(new URL('../skills/searxng/SKILL.md', import.meta.url), 'utf8');
  assert.equal(definition.content, bodyOnDisk, 'skill content must match the packaged file');
  assert.equal(registered.sections.length, 1, 'one prompt section expected');
  const section = registered.sections[0];
  assert.equal(Number.isFinite(section.order), true);
  const text = section.text({ scope: undefined });
  assert.ok(text.includes('systemctl --user status searxng'), 'section must teach the service check');
  assert.ok(text.includes('127.0.0.1:8888'), 'section must name the instance URL');
  console.log('skill + prompt section registration OK');
}

// 9. prompt section hides itself where web_search is not visible
{
  const { registered, ctx } = makeInjectingCtx({ withWebSearchTool: false });
  apply(ctx, {});
  const section = registered.sections[0];
  assert.equal(section.text({ scope: undefined }), '', 'section must render empty without web_search');
  console.log('scope-aware section text OK');
}

// 10. config switches disable the awareness halves
{
  const { registered, ctx } = makeInjectingCtx({ withWebSearchTool: true });
  apply(ctx, { promptSection: false, skill: false });
  assert.equal(registered.skills.length, 0);
  assert.equal(registered.sections.length, 0);
  console.log('awareness opt-outs OK');
}

// 11. plugin identity unchanged (the seam provider id the patch pins)
assert.equal(pluginName, 'searxng');

console.log('\nALL SMOKE TESTS PASSED');
