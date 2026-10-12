import { List, Map, Record, Seq, type RecordOf } from "immutable";
import { type CacheProfile } from "./cacheProfiles.js";
import { logger } from "./observability.js";

const CacheKey = Record({ path: '', queryNonListLike: Map<string, string>(), queryListLike: Map<string, string>() });

export class Cache<T, B> {
    profile: CacheProfile<T, B>
    inner: Map<
        RecordOf<{ path: string, queryNonListLike: Map<string, string>, queryListLike: Map<string, string> }>,
        [number, T]
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
                if (value != null) {
                    logger.debug(`set cache ${key}: ${value}`);
                    inner = inner.set(key, [ts, value]);
                } else {
                    logger.debug(`not setting cache ${key}`);
                }
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
                return this.inner.get(key);
            }
        );
        const populatedCacheResults = cacheResults.filter((x) => x != undefined);
        if (cacheResults.size === 0 || populatedCacheResults.size < cacheResults.size) return null;
        const earliestTs = populatedCacheResults.toSeq().map((x) => x[0]).reduce((acc, x) => Math.min(acc, x));

        return [earliestTs, populatedCacheResults.toSeq().map((x) => x[1]).reduce(this.profile.mergeCacheValues)];
    }
}

