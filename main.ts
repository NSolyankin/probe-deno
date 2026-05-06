// Полноценный прозрачный прокси Supabase на Deno Deploy.
// Принимает любой путь и проксирует на Supabase.
//
// Маршрутизация (на уровне Deno.serve, без отдельных rewrites):
//   /healthcheck        -> локальный быстрый ответ, без Supabase
//   /auth/v1/token      -> Supabase /auth/v1/token
//   /rest/v1/profiles   -> Supabase /rest/v1/profiles
//   /                   -> healthcheck
//
// CORS: эхо запрошенных заголовков (как в текущем Cloudflare Worker).

const SUPABASE_URL = 'https://nxxjbiwrkrlylpfypzvi.supabase.co';

// Заголовки запроса, которые лучше не передавать в Supabase.
const SKIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length',
  'cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'cf-visitor',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'forwarded'
]);

// Заголовки ответа, которые мы не возвращаем клиенту.
const HOP_BY_HOP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate',
  'content-encoding', 'content-length'
]);

// HTTP-статусы, для которых тело ответа обязано быть null
// (по спецификации Fetch / Web API). Если попытаться создать Response
// с непустым body для такого статуса, runtime бросит ошибку
// «Response with null body status cannot have body».
//
// Supabase отвечает 204 No Content на успешный DELETE — именно из-за
// этого случая ломалось удаление через прокси. Раньше код всегда читал
// arrayBuffer() и передавал его в new Response, что для 204 невалидно.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function corsHeaders(req) {
  const reqHeaders = req.headers.get('access-control-request-headers') || '*';
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': reqHeaders,
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(obj, req, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(req)
    }
  });
}

Deno.serve(async (req) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const pathName = url.pathname;

  // Healthcheck — отдельный быстрый ответ
  if (pathName === '/healthcheck' || pathName === '/' || pathName === '') {
    return jsonResponse({
      ok: true,
      platform: 'deno',
      timestamp: new Date().toISOString(),
      version: 'proxy-v2'
    }, req);
  }

  // Сборка целевого URL: SUPABASE_URL + pathName + search
  const targetUrl = SUPABASE_URL + pathName + url.search;

  // Заголовки запроса
  const fwdHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) return;
    fwdHeaders.set(key, value);
  });

  // Тело запроса
  let body = undefined;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (hasBody) {
    body = await req.arrayBuffer();
    if (body.byteLength === 0) body = undefined;
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body,
      redirect: 'manual'
    });

    // Заголовки ответа: сохраняем все, кроме hop-by-hop
    const respHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) return;
      respHeaders.set(key, value);
    });
    // CORS-заголовки поверх
    Object.entries(corsHeaders(req)).forEach(([k, v]) => respHeaders.set(k, v));

    // Тело ответа: для null-body статусов и для HEAD-запросов передаём null,
    // иначе runtime бросит ошибку «Response with null body status cannot
    // have body» при создании Response.
    // Для всех остальных случаев читаем upstream.arrayBuffer() и пробрасываем.
    let respBody = null;
    if (!NULL_BODY_STATUSES.has(upstream.status) && req.method !== 'HEAD') {
      respBody = await upstream.arrayBuffer();
    }

    return new Response(respBody, {
      status: upstream.status,
      headers: respHeaders
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      platform: 'deno',
      error: 'Upstream error: ' + (err && err.message || String(err))
    }, req, 502);
  }
});
