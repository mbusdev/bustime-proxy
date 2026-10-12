import * as z from 'zod';

const EnvConfig = z.object({
    PORT: z.coerce.number().min(0).max(2**16-1),
    SERVICE_NAME: z.string().default('local/bustime-proxy'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string(),
    OTEL_KEY: z.string(),
    PROXY_URL: z.string(),
    PROXY_KEY: z.string(),
    PROXY_KEY_PARAM: z.string(),
    PROXY_UPSTREAM_KEY: z.string(),
    CACHE_TTL_SECS: z.coerce.number().refine((x) => x > 0),
    CACHE_PROFILE: z.enum(['bustime']),
    CACHE_ADDITIONAL_REQUEST_LIMIT_MINUTELY: z.coerce.number().refine(x => x == Math.round(x) && x > 0),
    // CACHE_ADDITIONAL_REQUEST_BUCKET_INTERVAL_SECS: z.coerce.number().refine(x => x == Math.round(x) && x > 0),
});
const config = Object.freeze(EnvConfig.parse(process.env));

export default config;

