// Smoke test for the searxng search provider against the local instance.
// Run: node test/provider-smoke.mjs
import assert from 'node:assert/strict';
import { apply } from '../dsh/index.js';

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

console.log('\nALL SMOKE TESTS PASSED');
