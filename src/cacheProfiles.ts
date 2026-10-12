import { List, Set, Map, Seq, fromJS } from 'immutable';
import * as z from 'zod';

import { logger } from './observability.js';

/**
Behavior that depends on the service that is being proxied to and cached.
Currently logic is mostly bustime specific, but by passing the equivalents to
no-ops a simple route and query param deliminated cache can be achieved.

The generic T is _not_ the underlying cache datastructure, but what is stored
as a value in it.
*/
export type CacheProfile<T, B> = {
    mime: string,
    // handling conversion from http response to relevant forms for proxying
    // and caching
    getResponseBody: (res: Response) => Promise<B>,
    parseResponseBody: (res: B) => T,
    toResponseBody: (x: T) => B,
    /** how to process the the value of a list-like query param */
    splitQueryValue: (x: string) => Set<string>,
    /** filter a response to be cached to just the portions relevant for the
    given list param values */
    extractCacheValue: (listParamValues: Map<string, string>, x: T) => T | null,
    /** merged the portions returned by `extractCacheValue` back into a
    complete response, when the request has multiple values in its list-like
    query params */
    mergeCacheValues: (x1: T, x2: T) => T,
    /** which route + query param combinations are list-like */
    listParams: Map<string, Set<string>>,
};

const bustimeCacheProfile: CacheProfile<Map<string, JsonValue>, unknown> = {
    // the bustime servers do also support xml, but all expected use is in json
    mime: 'application/json',
    getResponseBody: async (res: Response) => await res.json(),
    parseResponseBody: bustimeParseResponseBody,
    toResponseBody: (x) => x.toJS(),
    splitQueryValue: (x: string) => Set(x.split(',')),
    // If an object (immutable Map) contains a list param with the wrong value,
    // remove that object. Removal only happens if that object is in a list. If
    // a list field of an object is rendered empty, remove that field.
    extractCacheValue: (lpvs, x) => {
        const extracted = bustimeExtractCacheValueMap(lpvs, x);
        if (extracted.size === 0) return null;
        return extracted;
    },
    mergeCacheValues: (x1, x2) => x1.mergeDeepWith((v1, v2) => {
        logger.warn(`incompatible merge needed between ${JSON.stringify(v1)} and ${JSON.stringify(v2)}`);
        return v2;
    }, x2),
    listParams: Map<string, Set<string>>([
        ['/getvehicles', Set(['vid', 'rt'])],
        ['/getstops', Set(['stpid'])],
        ['/getpatterns', Set(['pid'])],
        ['/getpredictions', Set(['stpid', 'rt', 'vid'])],
        ['/getservicebulletins', Set(['rt', 'stpid'])],
    ]),
};

type JsonPrimative = number | string | boolean | null;
type JsonValue = JsonPrimative | List<JsonValue> | Map<string, JsonValue>;

function isJsonPrimative(x: unknown): x is JsonPrimative {
    if (x === null) return true;
    if (typeof x === 'object') return false;
    return typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean'
}

function bustimeParseResponseBody(value: unknown): Map<string, JsonValue> {
    if (value == null || typeof value !== 'object' || Object.getPrototypeOf(value) != Object.prototype) {
        throw new Error('bustimeParseResponseBody: root is not a plain object');
    }
    return Map(Object.entries(value).map(([k, v]) => [k, parseJsonValue(v)]));
}

function parseJsonValue(x: unknown): JsonValue {
    if (isJsonPrimative(x)) return x;
    if (x instanceof Array) {
        return List(x.map(parseJsonValue));
    }
    if (typeof x !== 'object' || Object.getPrototypeOf(x) != Object.prototype) {
        throw new Error('bustimeParseResponseBodyHelper: unexpected input');
    }
    return Map(Object.entries(x).map(([k, v]) => [k, parseJsonValue(v)]));
};

function bustimeExtractCacheValueList(
    listParamValues: Map<string, string>, list: List<JsonValue>,
): List<JsonValue> {
    const filtered = list.filterNot((listValue) => {
        // only maps might be filtered
        if (!Map.isMap(listValue)) return false;
        // filter iff a nonmatching instance of the listparam is found
        return listValue.entrySeq().some(([k, v]) =>
            typeof v === 'string'
            && listParamValues.has(k)
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
    // recurse, then filter any keys with an empty list as the value or an empty map
    return Seq(x)
        .map((v) => {
            if (Map.isMap(v)) return bustimeExtractCacheValueMap(listParamValues, v);
            if (List.isList(v)) return bustimeExtractCacheValueList(listParamValues, v);
            return v;
        })
        .filterNot((v) => (List.isList(v) && v.size === 0) || (Map.isMap(v) && v.size === 0))
        .toMap();
}

const cacheProfiles = Object.freeze({
    bustime: bustimeCacheProfile,
});

export default cacheProfiles;
