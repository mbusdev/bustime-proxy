import { logger, tracer, meter } from './observability.js';

import express from 'express';
import * as HyperDX from '@hyperdx/node-opentelemetry';
import { Map } from 'immutable';
import urlJoin from 'url-join';
import * as z from 'zod';

import config from './config.js';
import { Cache } from './cache.js';
import cacheProfiles from './cacheProfiles.js';

// const requests = meter.createCounter('requests', { description: 'number of requests' });

const cacheProfile = cacheProfiles[config.CACHE_PROFILE];
const cache = new Cache(cacheProfile);
let remainingAdditionalRequests = config.CACHE_ADDITIONAL_REQUEST_LIMIT_MINUTELY;

setInterval(() => remainingAdditionalRequests = config.CACHE_ADDITIONAL_REQUEST_LIMIT_MINUTELY, 60000);

const cacheSize = meter.createObservableGauge('cache_size');
cacheSize.addCallback((x) => x.observe(cache.inner.size));
const remainingAdditionalRequestsGauge = meter.createObservableGauge('remaining_additional_requests');
remainingAdditionalRequestsGauge.addCallback((x) => x.observe(remainingAdditionalRequests));

const requests = meter.createCounter('requests');
const rateLimitFailures = meter.createCounter('rate_limit_failures');
const cacheStaleness = meter.createHistogram('cache_staleness');
const cacheHits = meter.createCounter('cache_hits');
const cacheMissesStale = meter.createCounter('cache_misses_stale');
const cacheMissesMissing = meter.createCounter('cache_misses_missing');
const cacheBypasses = meter.createCounter('cache_bypasses');

// TODO: cache key cleanup

const app = express();

const SimpleQuery = z.record(z.string(), z.string());

app.get('/*ask', async (req, res) => {
    requests.add(1);
    const path = req.path;
    const rawQuery = SimpleQuery.parse(req.query);
    const query = Map(Object.entries(rawQuery));
    const queryNoApiKey = query.filterNot((_, k) => k == config.PROXY_KEY_PARAM);
    
    // api key
    const providedKey = query.get(config.PROXY_KEY_PARAM);
    if (providedKey == undefined) {
        res.status(401).send('an api key is needed in query param ' + config.PROXY_KEY_PARAM);
        return;
    }
    let bypassNeeded = false;
    if (providedKey == config.PROXY_KEY) {
        // serve from cache
        logger.debug('trying to serve from cache');
        const cacheResult = cache.access(path, queryNoApiKey);

        if (cacheResult == null) {
            cacheMissesMissing.add(1);
            bypassNeeded = true;
        } else {
            const staleness = new Date().getTime() - cacheResult[0];
            if (staleness > config.CACHE_TTL_SECS * 1000) {
                cacheMissesStale.add(1);
                bypassNeeded = true;
            } else {
                cacheHits.add(1);
                cacheStaleness.record(staleness);
                res.type(cacheProfile.mime);
                res.status(200).send(cacheProfile.toResponseBody(cacheResult[1]));
                return;
            }
        }
    }
    if (providedKey == config.PROXY_UPSTREAM_KEY || (bypassNeeded && remainingAdditionalRequests > 0)) {
        // directly proxy the request
        cacheBypasses.add(1);
        if (bypassNeeded) {
            remainingAdditionalRequests -= 1;
        }

        const responseBodyParsed = await tracer.startActiveSpan('upstream_request', async (span) => {
            try {
                // FIXME: replace api key properly
                // TODO: support keyless upstream services
                const url = urlJoin(config.PROXY_URL, req.originalUrl)
                    .replace(providedKey, config.PROXY_UPSTREAM_KEY);
                logger.debug(`requesting ${url}`);

                const response = await fetch(url);
                const responseBody = await cacheProfile.getResponseBody(response);
                res.type(cacheProfile.mime);
                res.status(response.status).send(responseBody);

                const responseBodyParsed = cacheProfile.parseResponseBody(responseBody);
                return responseBodyParsed;
            } finally {
                span.end();
            }
        });
        // update the cache
        cache.updateWith(new Date().getTime(), path, queryNoApiKey, responseBodyParsed);
    } else if (bypassNeeded) {
        logger.warn('rate limited');
        rateLimitFailures.add(1);
        res.sendStatus(429);
    } else {
        // invalid key
        res.status(403).send('invalid api key');
    }
});

HyperDX.setupExpressErrorHandler(app);

const server = app.listen(config.PORT, () => {
    const addr = server.address();
    if (addr == null) {
        logger.error('unable to bind!');
    }
    logger.info(`listening on ${JSON.stringify(server.address())}`);
});

