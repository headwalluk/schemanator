/**
 * A throwaway HTTP server for tests.
 *
 * Binds port 0 so the OS assigns a free one — the dev host runs many services
 * full-time and this must never squat on a real port.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Delay before responding, for timeout tests. */
  delayMs?: number;
}

export type Route = RouteResponse | ((request: http.IncomingMessage, hit: number) => RouteResponse);

export interface TestServer {
  origin: string;
  url(path: string): string;
  /** How many times each path has been requested — proves we did not drain a rejected body. */
  hits: Map<string, number>;
  close(): Promise<void>;
}

export async function startTestServer(routes: Record<string, Route>): Promise<TestServer> {
  const hits = new Map<string, number>();

  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('#')[0] ?? '/';
    const hit = (hits.get(path) ?? 0) + 1;
    hits.set(path, hit);

    const route = routes[path];
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    const resolved = typeof route === 'function' ? route(request, hit) : route;

    const send = (): void => {
      response.writeHead(resolved.status ?? 200, {
        'content-type': 'text/html; charset=utf-8',
        ...resolved.headers,
      });
      response.end(resolved.body ?? '');
    };

    if (resolved.delayMs !== undefined && resolved.delayMs > 0) {
      setTimeout(send, resolved.delayMs);
    } else {
      send();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path: string) => `${origin}${path}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
