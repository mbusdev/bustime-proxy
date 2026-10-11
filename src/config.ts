import * as z from 'zod';

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

export default config;

