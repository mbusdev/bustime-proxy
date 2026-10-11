import { logger, tracer, meter } from './observability.js';

import express from 'express';

const requests = meter.createCounter('requests', { description: 'number of requests' });

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

