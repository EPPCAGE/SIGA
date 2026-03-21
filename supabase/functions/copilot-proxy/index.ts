// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const GITHUB_COPILOT_TOKEN = Deno.env.get('GITHUB_COPILOT_TOKEN') ?? Deno.env.get('GITHUB_TOKEN') ?? '';
const GITHUB_COPILOT_API_URL = Deno.env.get('GITHUB_COPILOT_API_URL') ?? 'https://models.github.ai/inference/chat/completions';
const GITHUB_COPILOT_MODEL = Deno.env.get('GITHUB_COPILOT_MODEL') ?? 'openai/gpt-4.1-mini';

const MAX_PROMPT_CHARS = 24000;
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

function getBearerToken(req: Request): string {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? '';
}

function decodeJwtEmail(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const payloadPart = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadPart.padEnd(Math.ceil(payloadPart.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
  } catch (_e) {
    return '';
  }
}

async function isEditor(email: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !email) return false;
  const endpoint = `${SUPABASE_URL}/rest/v1/gestpop_editors?select=email&email=eq.${encodeURIComponent(email)}&limit=1`;
  try {
    const resp = await fetch(endpoint, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return Array.isArray(data) && data.length > 0;
  } catch (_e) {
    return false;
  }
}

function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeImage(image: unknown): { data: string; mimeType: string } | null {
  if (!image || typeof image !== 'object') return null;
  const data = safeTrim((image as any).data);
  const mimeType = safeTrim((image as any).mimeType).toLowerCase();
  if (!data || !mimeType.startsWith('image/')) return null;

  const estimatedBytes = Math.ceil((data.length * 3) / 4);
  if (estimatedBytes > MAX_IMAGE_BYTES) {
    throw new Error('Imagem excede limite de 5MB');
  }

  return { data, mimeType };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if ((part as any).type === 'text' && typeof (part as any).text === 'string') {
        return (part as any).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if (!GITHUB_COPILOT_TOKEN) {
    return jsonResponse(503, { error: 'GITHUB_COPILOT_TOKEN nao configurado' });
  }

  const token = getBearerToken(req);
  const requesterEmail = decodeJwtEmail(token);
  if (!token || !requesterEmail) {
    return jsonResponse(401, { error: 'Token invalido ou ausente' });
  }

  const allowed = await isEditor(requesterEmail);
  if (!allowed) {
    return jsonResponse(403, { error: 'Apenas editores podem usar a IA' });
  }

  let body: { prompt?: string; image?: unknown };
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse(400, { error: 'Corpo invalido' });
  }

  const prompt = safeTrim(body?.prompt);
  if (!prompt) {
    return jsonResponse(400, { error: 'Campo obrigatorio: prompt' });
  }

  if (prompt.length > MAX_PROMPT_CHARS) {
    return jsonResponse(400, { error: 'Prompt muito grande (max 24000 caracteres)' });
  }

  let image: { data: string; mimeType: string } | null = null;
  try {
    image = normalizeImage(body?.image);
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : 'Imagem invalida' });
  }

  const userContent: any[] = [{ type: 'text', text: prompt }];
  if (image) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    });
  }

  const payload = {
    model: GITHUB_COPILOT_MODEL,
    messages: [
      {
        role: 'system',
        content: 'Voce e um assistente para analise de processos da CAGE-RS. Responda em portugues de forma objetiva e estruturada.',
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    temperature: 0.2,
    max_tokens: 1800,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);

  let resp: Response;
  try {
    resp = await fetch(GITHUB_COPILOT_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_COPILOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(502, { error: `Falha de comunicacao com a API de IA: ${msg}` });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await resp.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_e) {
    data = { raw };
  }

  if (!resp.ok) {
    return jsonResponse(resp.status, {
      error: 'Falha na API de IA',
      details: data,
    });
  }

  const text = extractText(data?.choices?.[0]?.message?.content).trim();
  if (!text) {
    return jsonResponse(502, { error: 'Resposta da IA vazia ou invalida' });
  }

  return jsonResponse(200, { text });
});
