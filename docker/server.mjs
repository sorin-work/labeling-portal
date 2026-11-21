// The production web server: what react-router-serve does (compression,
// static files with the same cache headers, request log, a clean stop on
// SIGTERM), plus one thing it cannot do: hand the socket's peer address to
// the app as `context.clientAddress`, for the sign-in limits per client.
// Behind a proxy that peer is the proxy; set TRUST_PROXY=true there so the
// app reads X-Forwarded-For instead.
/* global process, console */
import path from 'node:path';

import { createRequestHandler } from '@react-router/express';
import compression from 'compression';
import express from 'express';
import morgan from 'morgan';

const build = await import('../build/server/index.js');
const port = Number(process.env.PORT || 3000);

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(
  path.posix.join(build.publicPath, 'assets'),
  express.static(path.join(build.assetsBuildDirectory, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }),
);
app.use(build.publicPath, express.static(build.assetsBuildDirectory));
app.use(express.static('public', { maxAge: '1h' }));
app.use(morgan('tiny'));
app.all(
  '*',
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
    getLoadContext: (req) => ({ clientAddress: req.socket.remoteAddress ?? undefined }),
  }),
);

const server = app.listen(port, () => console.log(`[server] http://localhost:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(console.error));
}
