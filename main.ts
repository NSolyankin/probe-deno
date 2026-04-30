// Разведочный прокси-эндпоинт на Deno Deploy.
// Цель: узнать, проходит ли ТСПУ запросы к *.deno.dev.
//
// Маршруты:
//   GET  /healthcheck   -> {"ok":true,"platform":"deno"}
//   GET  /test-supabase -> результат GET-запроса к Supabase
//   POST /test-echo     -> возвращает тело запроса обратно

const SUPABASE_URL = 'https://nxxjbiwrkrlylpfypzvi.supabase.co';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

Deno.serve(async (req) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // healthcheck — простой ответ, что прокси жив
  if (path === '/healthcheck') {
    return jsonResponse({
      ok: true,
      platform: 'deno',
      timestamp: new Date().toISOString()
    });
  }

  // test-supabase — пробуем сходить на Supabase из этого прокси
  if (path === '/test-supabase') {
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/', {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      const text = await r.text();
      return jsonResponse({
        ok: true,
        platform: 'deno',
        supabase_status: r.status,
        supabase_response_preview: text.slice(0, 200)
      });
    } catch (e) {
      return jsonResponse({
        ok: false,
        platform: 'deno',
        error: String(e && e.message || e)
      }, 500);
    }
  }

  // test-echo — принимает POST с JSON и возвращает обратно
  if (path === '/test-echo') {
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'POST required for test-echo' }, 405);
    }
    let body = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    return jsonResponse({
      ok: true,
      platform: 'deno',
      method: req.method,
      received_body: body,
      headers_seen: {
        'content-type': req.headers.get('content-type'),
        'user-agent': req.headers.get('user-agent')
      }
    });
  }

  // Главная страница — краткая справка
  if (path === '/') {
    return new Response(
      'probe-deno: разведочный прокси.\n\n' +
      'Endpoints:\n' +
      '  GET  /healthcheck\n' +
      '  GET  /test-supabase\n' +
      '  POST /test-echo (JSON body)\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders } }
    );
  }

  return jsonResponse({ ok: false, error: 'Unknown path: ' + path }, 404);
});
