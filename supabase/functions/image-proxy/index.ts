import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  let url: string | undefined;

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      url = body?.url;
    } catch (_e) {
      return new Response(JSON.stringify({ error: 'Corpo inválido' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } else if (req.method === 'GET') {
    url = new URL(req.url).searchParams.get('url') ?? undefined;
  }

  if (!url || !url.startsWith('http')) {
    return new Response(JSON.stringify({ error: 'Parâmetro "url" inválido ou ausente' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GesProc-RS/1.0)' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Erro ao buscar imagem: ${e.message}` }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!resp.ok) {
    return new Response(JSON.stringify({ error: `Servidor remoto retornou ${resp.status}` }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const contentType = resp.headers.get('content-type') || 'image/png';
  const arrayBuffer = await resp.arrayBuffer();

  if (arrayBuffer.byteLength < 100) {
    return new Response(JSON.stringify({ error: 'Resposta muito pequena — não é uma imagem válida' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Converte para base64
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8.byteLength; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64 = btoa(binary);
  const mimeType = contentType.split(';')[0].trim();
  const dataUrl = `data:${mimeType};base64,${base64}`;

  return new Response(JSON.stringify({ dataUrl }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
