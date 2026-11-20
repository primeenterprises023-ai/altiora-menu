const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export const created = (data: unknown, headers?: Record<string, string>) => json(data, 201, headers);

export function noContent(headers?: Record<string, string>): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...headers } });
}
