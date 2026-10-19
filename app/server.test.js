const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createServer } = require('node:http');
const { createApp, readCacheTtlSeconds } = require('./server');

function createRedisStub() {
  const cache = new Map();
  const redisClient = {
    isReady: true,
    get: async (key) => cache.get(key) ?? null,
    setEx: async (key, ttl, value) => {
      redisClient.lastSet = { key, ttl, value };
      cache.set(key, value);
    },
  };
  return redisClient;
}

const redisClient = createRedisStub();
const server = createServer(createApp(redisClient, 45));
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('returns a cache miss, stores the value with the configured TTL, then returns a hit', async () => {
  const missResponse = await fetch(baseUrl);
  const missBody = await missResponse.text();

  assert.equal(missResponse.status, 200);
  assert.match(missBody, /^\[CACHE MISS\] Rendered page generated at /);
  assert.equal(redisClient.lastSet.key, 'rendered_content_page');
  assert.equal(redisClient.lastSet.ttl, 45);

  const hitResponse = await fetch(baseUrl);
  const hitBody = await hitResponse.text();
  assert.equal(hitResponse.status, 200);
  assert.equal(hitBody, missBody.replace('[CACHE MISS]', '[CACHE HIT]'));
});

test('health endpoint is live and readiness follows Redis state', async () => {
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);

  redisClient.isReady = false;
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
  redisClient.isReady = true;
});

test('returns an internal server error when Redis fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(redisClient, 'get', async () => {
    throw new Error('Redis unavailable');
  });

  const response = await fetch(baseUrl);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Internal Server Error');
});

test('rejects invalid cache TTL values', () => {
  assert.equal(readCacheTtlSeconds(undefined), 30);
  assert.equal(readCacheTtlSeconds('60'), 60);
  assert.throws(() => readCacheTtlSeconds('0'), /positive integer/);
  assert.throws(() => readCacheTtlSeconds('invalid'), /positive integer/);
});
