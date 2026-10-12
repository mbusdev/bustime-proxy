import { List, Map, Record, Seq, type RecordOf } from "immutable";
import { type CacheProfile } from "./cacheProfiles.js";
import { logger } from "./observability.js";

const CacheKey = Record({ path: '', queryNonListLike: Map<string, string>(), queryListLike: Map<string, string>() });

export class Cache<T, B> {
    profile: CacheProfile<T, B>
    inner: Map<
        RecordOf<{ path: string, queryNonListLike: Map<string, string>, queryListLike: Map<string, string> }>,
        [number, T | null]
    >

    constructor(profile: CacheProfile<T, B>) {
        this.profile = profile;        
        this.inner = Map();
    }

    /** the api key is expected to be filtered from query already */
    updateWith(ts: number, path: string, query: Map<string, string>, response: T) {
        const listParams = this.profile.listParams.get(path);
        const [queryNonListLike, queryListLikeRaw] = Seq(query)
            .partition((_, k) => listParams?.has(k) ?? false);
        const queryListLikeCombos = queryListLikeRaw
            .map(this.profile.splitQueryValue)
            .reduce(
                (acc, listValues, listKey) => {
                    return acc.flatMap((prefix) => {
                        return listValues.map((listValue) => prefix.set(listKey, listValue))
                    });
                }, List<Map<string, string>>([Map()]),
            );

        logger.debug(`there are ${queryListLikeCombos.size} combos`);

        this.inner = this.inner.withMutations((inner) => {
            queryListLikeCombos.forEach((queryListLike) => {
                const value = this.profile.extractCacheValue(queryListLike, response);
                const key = CacheKey({ path, queryNonListLike: queryNonListLike.toMap(), queryListLike });
                logger.debug(`set cache ${key}: ${value}`);
                inner = inner.set(key, [ts, value]);
            });
        });
    }

    /** the api key is expected to be filtered from query already */
    access(path: string, query: Map<string, string>): [number, T] | null {
        const listParams = this.profile.listParams.get(path);
        const [queryNonListLike, queryListLikeRaw] = Seq(query)
            .partition((_, k) => listParams?.has(k) ?? false);
        let queryListLikeCombos = queryListLikeRaw
            .map(this.profile.splitQueryValue)
            .reduce(
                (acc, listValues, listKey) => {
                    return acc.flatMap((prefix) => {
                        return listValues.map((listValue) => prefix.set(listKey, listValue))
                    });
                }, List<Map<string, string>>([Map()]),
            );
        if (queryListLikeCombos.size == 0) {
            queryListLikeCombos = queryListLikeCombos.push(Map());
        }
        logger.debug(`there are ${queryListLikeCombos.size} combos`);
        const cacheResults = queryListLikeCombos.map(
            (queryListLike) => {
                const key = CacheKey({
                    path, queryNonListLike: queryNonListLike.toMap(), queryListLike
                });
                logger.debug(`get cache ${key}`);
                const val = this.inner.get(key);
                if (val == undefined) {
                    logger.debug(`cache miss due to key ${key}`);
                }
                return val;
            }
        );
        let notUndefCacheResults = cacheResults.filter((x) => x != undefined);
        // if an undefined is present, the cache is incomplete
        if (cacheResults.size === 0 || notUndefCacheResults.size < cacheResults.size) return null;
        const earliestTs = notUndefCacheResults.toSeq()
            .map((x) => x[0])
            .reduce((acc, x) => Math.min(acc, x));
        const populatedCacheValues = notUndefCacheResults.toSeq()
            .map((x) => x[1])
            .filter((x) => x != null);
        // if all nulls, we can't make a result
        if (populatedCacheValues.size === 0) return null;

        return [earliestTs, populatedCacheValues.reduce(this.profile.mergeCacheValues)];
    }
}

