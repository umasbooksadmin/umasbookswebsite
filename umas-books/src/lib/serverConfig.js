// HTTP server timeouts. Node's default keepAliveTimeout is 5 s, but Render's load balancer (and Cloudflare in front
// of it) reuse an idle connection for longer. When Node closes a connection just as the proxy sends a request on it,
// the visitor sees a sporadic 502 / ECONNRESET on the first request after a pause. The server must therefore keep
// idle connections open LONGER than the proxy does (Render: 60 s idle, Cloudflare: 120 s on its origin side but it
// retries; 65 s is the usual margin over 60 s). headersTimeout must exceed keepAliveTimeout, or Node can drop a
// reused connection while waiting for the next request's headers.
const KEEP_ALIVE_TIMEOUT_MS = 65 * 1000;
const HEADERS_TIMEOUT_MS = 66 * 1000;

function configureServer(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

module.exports = { configureServer, KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS };
