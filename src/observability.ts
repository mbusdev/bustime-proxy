import * as HyperDX from '@hyperdx/node-opentelemetry';
import opentelemetry from '@opentelemetry/api';
import pino from 'pino';

import config from './config.js';

// must be before any meters are created
HyperDX.init({
    apiKey: config.OTEL_KEY,
    service: config.SERVICE_NAME,
});

export const logger = pino({
    mixin: HyperDX.getPinoMixinFunction,
    transport: {
        targets: [
            HyperDX.getPinoTransport('info'),
            { target: 'pino/file', options: { destination: 1 } },
        ],
    },
});

export const tracer = opentelemetry.trace.getTracer('bustime-proxy', '0.1.0');
export const meter = opentelemetry.metrics.getMeter('bustime-proxy', '0.1.0');

logger.info('config loaded, otel and logger initialized');


