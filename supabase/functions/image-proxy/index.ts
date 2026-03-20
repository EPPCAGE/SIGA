import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ALLOWED_HOSTS = (Deno.env.get('IMAGE_PROXY_ALLOWED_HOSTS') ?? 'cage.fazenda.rs.gov.br,qdpkkzdlpdwoqqmbzpll.supabase.co')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (/^[a-f0-9:]+$/i.test(host) && (host.startsWith('fc') || host.startsWith('fd'))) return true;
  return false;
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let url: string | undefined;

  try {
    const body = await req.json();
    url = body?.url;
  } catch (_e) {
    return jsonResponse(400, { error: 'Corpo invalido' });
  }

  if (!url) {
    return jsonResponse(400, { error: 'Parametro "url" invalido ou ausente' });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch (_e) {
    return jsonResponse(400, { error: 'URL invalida' });
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return jsonResponse(400, { error: 'Somente protocolos http/https sao permitidos' });
  }

  if (isPrivateHost(target.hostname)) {
    return jsonResponse(403, { error: 'Host privado nao permitido' });
  }

  if (!hostAllowed(target.hostname)) {
    return jsonResponse(403, { error: 'Host nao permitido pelo proxy' });
  }

  let resp: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    resp = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GesProc-RS/1.0)' },
      signal: controller.signal,
    });
  } catch (e) {
    return jsonResponse(502, { error: `Erro ao buscar imagem: ${e.message}` });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    return jsonResponse(502, { error: `Servidor remoto retornou ${resp.status}` });
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    return jsonResponse(415, { error: 'Resposta nao e uma imagem valida' });
  }

  const contentLength = Number(resp.headers.get('content-length') || '0');
  if (contentLength > MAX_IMAGE_BYTES) {
    return jsonResponse(413, { error: 'Imagem excede limite de 5MB' });
  }

  const arrayBuffer = await resp.arrayBuffer();

  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    return jsonResponse(413, { error: 'Imagem excede limite de 5MB' });
  }

  if (arrayBuffer.byteLength < 100) {
    return jsonResponse(502, { error: 'Resposta muito pequena - nao e uma imagem valida' });
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

  return jsonResponse(200, { dataUrl });
});
