const express = require('express');
const { createClient } = require('redis');

const CACHE_KEY = 'rendered_content_page';
const DEFAULT_CACHE_TTL_SECONDS = 30;
const REDIS_RETRY_DELAY_MS = 1000;

function readCacheTtlSeconds(value = process.env.CACHE_TTL_SECONDS) {
  if (value === undefined) {
    return DEFAULT_CACHE_TTL_SECONDS;
  }

  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw new Error('CACHE_TTL_SECONDS must be a positive integer');
  }

  return ttl;
}

function createApp(redisClient, cacheTtlSeconds = readCacheTtlSeconds()) {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  app.get('/readyz', (_req, res) => {
    if (!redisClient.isReady) {
      return res.status(503).send('Redis is not ready');
    }

    return res.status(200).send('ready');
  });

  app.get('/', async (_req, res) => {
    try {
      const cachedData = await redisClient.get(CACHE_KEY);
      if (cachedData) {
        return res.send(`[CACHE HIT] ${cachedData}`);
      }

      const freshData = `Rendered page generated at ${new Date().toISOString()} (Heavy Computation)`;
      await redisClient.setEx(CACHE_KEY, cacheTtlSeconds, freshData);
      return res.send(`[CACHE MISS] ${freshData}`);
    } catch (error) {
      console.error('Failed to render page using Redis cache', error);
      return res.status(500).send('Internal Server Error');
    }
  });

  return app;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectRedis(redisClient, isStopping) {
  while (!isStopping() && !redisClient.isReady) {
    if (redisClient.isOpen) {
      await delay(REDIS_RETRY_DELAY_MS);
      continue;
    }

    try {
      await redisClient.connect();
    } catch (error) {
      console.error('Unable to connect to Redis; retrying', error);
      await delay(REDIS_RETRY_DELAY_MS);
    }
  }
}

function start() {
  const redisClient = createClient({
    url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 250, 3000),
    },
  });
  redisClient.on('error', (error) => console.error('Redis client error', error));

  const cacheTtlSeconds = readCacheTtlSeconds();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const server = createApp(redisClient, cacheTtlSeconds).listen(port, () => {
    console.log(`Web app listening on port ${port}`);
  });

  let stopping = false;
  void connectRedis(redisClient, () => stopping);

  const shutdown = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`Received ${signal}; shutting down`);

    const shutdownTimeout = setTimeout(() => {
      console.error('Graceful shutdown timed out');
      process.exit(1);
    }, 10000);
    shutdownTimeout.unref();

    server.close((error) => {
      if (error) {
        console.error('Failed to close HTTP server cleanly', error);
        process.exitCode = 1;
      }

      const closeRedis = redisClient.isReady
        ? redisClient.quit()
        : redisClient.isOpen
          ? redisClient.disconnect()
          : Promise.resolve();

      void closeRedis
        .then(() => clearTimeout(shutdownTimeout))
        .catch((redisError) => {
          console.error('Failed to close Redis connection cleanly', redisError);
          process.exitCode = 1;
          clearTimeout(shutdownTimeout);
        });
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = { createApp, readCacheTtlSeconds };
