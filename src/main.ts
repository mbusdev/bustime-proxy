import * as HyperDX from '@hyperdx/node-opentelemetry';
import express from 'express';
import opentelemetry from '@opentelemetry/api';
import pino from 'pino';
import * as z from 'zod';
import { List, Map, Seq, Set } from 'immutable';

const EnvConfig = z.object({
    SERVICE_NAME: z.string().default('local/bustime-proxy'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string(),
    OTEL_KEY: z.string(),
    PROXY_URL: z.string(),
    PROXY_KEY: z.string(),
    PROXY_KEY_PARAM: z.string(),
    CACHE_TTL_SECS: z.coerce.number().refine((x) => x > 0),
    CACHE_PROFILE: z.enum(['bustime']),
});
const config = Object.freeze(EnvConfig.parse(process.env));

// must be before any meters are created
HyperDX.init({
    apiKey: config.OTEL_KEY,
    service: config.SERVICE_NAME,
});

const tracer = opentelemetry.trace.getTracer('bustime-proxy', '0.1.0');
const meter = opentelemetry.metrics.getMeter('bustime-proxy', '0.1.0');

const requests = meter.createCounter('requests', { description: 'number of requests' });

const logger = pino({
    mixin: HyperDX.getPinoMixinFunction,
    transport: {
        targets: [
            HyperDX.getPinoTransport('info'),
            { target: 'pino/file', options: { destination: 1 } },
        ],
    },
});

logger.info('config loaded, otel and logger initialized');

/**
Behavior that depends on the service that is being proxied to and cached.
Currently logic is mostly bustime specific, but by passing the equivalents to
no-ops a simple route and query param deliminated cache can be achieved.

The generic T is _not_ the underlying cache datastructure, but what is stored
as a value in it.
*/
type CacheProfile<T> = {
    /** how to process the the value of a list-like query param */
    splitQueryValue: (x: string) => Set<string>,
    /** filter a response to be cached to just the portions relevant for the
    given list param values */
    extractCacheValue: (listParamValues: Map<string, string>, x: T) => T,
    /** merged the portions returned by `extractCacheValue` back into a
    complete response, when the request has multiple values in its list-like
    query params */
    mergeCacheValues: (x1: T, x2: T) => T,
    /** which route + query param combinations are list-like */
    listParams: Map<string, Set<string>>,
};

const bustimeCacheProfile: CacheProfile<Map<string, JsonValue>> = {
    splitQueryValue: (x: string) => Set(x.split(',')),
    // If an object (immutable Map) contains a list param with the wrong value,
    // remove that object. Removal only happens if that object is in a list. If
    // a list field of an object is rendered empty, remove that field.
    extractCacheValue: bustimeExtractCacheValueMap,
    mergeCacheValues: (x1, x2) => x1.mergeDeepWith((v1, v2) => {
        logger.warn(`incompatible merge needed between ${JSON.stringify(v1)} and ${JSON.stringify(v2)}`);
        return v2;
    }, x2),
    listParams: Map<string, Set<string>>([
        ['getvehicles', Set(['vid', 'rt'])],
        ['getstops', Set(['stpid'])],
        ['getpatterns', Set(['pid'])],
        ['getpredictions', Set(['stpid', 'rt', 'vid'])],
        ['getservicebulletins', Set(['rt', 'stpid'])],
    ]),
};

type JsonPrimative = number | string | boolean | null;
type JsonValue = JsonPrimative | List<JsonValue> | Map<string, JsonValue>;

function isJsonPrimative(x: unknown): x is JsonPrimative {
    if (x === null) return true;
    if (typeof x === 'object') return false;
    return typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean'
}

function bustimeExtractCacheValueList(
    listParamValues: Map<string, string>, list: List<JsonValue>,
): List<JsonValue> {
    const filtered = list.filterNot((listValue) => {
        // only maps might be filtered
        if (!Map.isMap(listValue)) return false;
        // filter iff a nonmatching instance of the listparam is found
        return listValue.entrySeq().some(([k, v]) =>
            typeof v === 'string'
            && listParamValues.contains(k)
            && listParamValues.get(k) != v)
    });
    // successful filter => at right depth and no need to go deeper
    if (filtered.size != list.size) return filtered;
    // otherwise go deeper / stop if at a primative (not Map/List)
    return Seq(list)
        .map((v) => {
            if (Map.isMap(v)) return bustimeExtractCacheValueMap(listParamValues, v);
            if (List.isList(v)) return bustimeExtractCacheValueList(listParamValues, v);
            return v;
        })
        .toList();
}

function bustimeExtractCacheValueMap(
    listParamValues: Map<string, string>, x: Map<string, JsonValue>,
): Map<string, JsonValue> {
    // recurse, then filter any keys with an empty list as the value
    return Seq(x)
        .map((v) => {
            if (Map.isMap(v)) return bustimeExtractCacheValueMap(listParamValues, v);
            if (List.isList(v)) return bustimeExtractCacheValueList(listParamValues, v);
            return v;
        })
        .filterNot((v) => List.isList(v) && v.size === 0)
        .toMap();
}

const cacheProfiles = Object.freeze({
    bustime: bustimeCacheProfile,
});

const app = express();
app.get('/', (req, res) => {
    requests.add(1);
    tracer.startActiveSpan('inner-work', span => {
        span.setAttribute('foos', 2.5);
        span.end(); 
    });
    res.send('Hello world');
});

app.listen(3000, () => {
    logger.info('listening..');
});

