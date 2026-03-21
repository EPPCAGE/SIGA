// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const GITHUB_COPILOT_TOKEN = Deno.env.get('GITHUB_COPILOT_TOKEN') ?? Deno.env.get('GITHUB_TOKEN') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('gemini_api_key') ?? '';

// Prefer GitHub Copilot when token is available; fall back to Gemini.
const USE_GITHUB = !!GITHUB_COPILOT_TOKEN;
const AI_API_URL = USE_GITHUB
  ? (Deno.env.get('GITHUB_COPILOT_API_URL') ?? 'https://models.github.ai/inference/chat/completions')
  : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const AI_TOKEN = USE_GITHUB ? GITHUB_COPILOT_TOKEN : GEMINI_API_KEY;
const PRIMARY_MODEL = USE_GITHUB
  ? (Deno.env.get('GITHUB_COPILOT_MODEL') ?? 'openai/gpt-4.1-mini')
  : (Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash-lite');
// Lido de env para evitar hardcode de e-mail no código-fonte.
const ADMIN_EMAIL = Deno.env.get('SIGA_ADMIN_EMAIL') ?? '';
const FALLBACK_MODELS = USE_GITHUB
  ? ['openai/gpt-4o-mini', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']
  : ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];

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

function decodeJwtSub(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const payloadPart = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadPart.padEnd(Math.ceil(payloadPart.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  } catch (_e) {
    return '';
  }
}

async function getRequesterEmail(token: string): Promise<string> {
  if (!token) return '';

  // Prefer asking Supabase Auth for the canonical user e-mail.
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${token}`,
        },
      });
      if (resp.ok) {
        const user = await resp.json();
        const email = safeTrim(user?.email).toLowerCase();
        if (email) return email;
      }
    } catch (_e) {
      // Fall through to JWT decode fallback.
    }
  }

  // Some tokens may miss an email claim; resolve by user id via admin endpoint.
  const sub = decodeJwtSub(token);
  if (sub && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const adminResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(sub)}`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (adminResp.ok) {
        const data = await adminResp.json();
        const email = safeTrim(data?.email).toLowerCase();
        if (email) return email;
      }
    } catch (_e) {
      // Continue fallback chain.
    }
  }

  return decodeJwtEmail(token);
}

async function isEditor(email: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !email) return false;
  if (email.trim().toLowerCase() === ADMIN_EMAIL) return true;
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

function uniqueModelList(): string[] {
  const ordered = [safeTrim(PRIMARY_MODEL), ...FALLBACK_MODELS].filter(Boolean);
  return [...new Set(ordered)];
}

function extractProviderErrorCode(data: any): string {
  return safeTrim(data?.error?.code).toLowerCase();
}

function extractProviderErrorMessage(data: any): string {
  return safeTrim(data?.error?.message || data?.message || data?.error_description);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if (!AI_TOKEN) {
    return jsonResponse(503, { error: 'Nenhuma chave de IA configurada (GEMINI_API_KEY ou GITHUB_COPILOT_TOKEN)' });
  }

  const token = getBearerToken(req);
  const requesterEmail = await getRequesterEmail(token);
  if (!token || !requesterEmail) {
    return jsonResponse(401, { error: 'Token invalido ou ausente' });
  }

  const allowed = await isEditor(requesterEmail);
  if (!allowed) {
    return jsonResponse(403, {
      error: 'Apenas editores podem usar a IA',
      requesterEmail,
      adminEmail: ADMIN_EMAIL,
    });
  }

  let body: { prompt?: string; image?: unknown; maxTokens?: number };
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

  const requestedTokens = typeof body?.maxTokens === 'number' ? body.maxTokens : 1800;
  const resolvedMaxTokens = Math.min(Math.max(requestedTokens, 256), 16384);

  const basePayload = {
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
    max_tokens: resolvedMaxTokens,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);

  const triedModels: string[] = [];
  let finalResp: Response | null = null;
  let finalData: any = {};
  let lastErrorCode = '';

  try {
    for (const model of uniqueModelList()) {
      triedModels.push(model);
      const payload = { ...basePayload, model };

      const resp = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await resp.text();
      let data: any = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (_e) {
        data = { raw };
      }

      if (resp.ok) {
        finalResp = resp;
        finalData = data;
        break;
      }

      lastErrorCode = extractProviderErrorCode(data);
      const msg = extractProviderErrorMessage(data).toLowerCase();
      const isNoAccess = lastErrorCode === 'no_access' || msg.includes('no access to model');
      const isOverloaded = resp.status === 503 || resp.status === 429 ||
        msg.includes('overloaded') || msg.includes('high demand') || msg.includes('capacity');
      if ((resp.status === 403 && isNoAccess) || resp.status === 404 || isOverloaded) {
        continue;
      }

      return jsonResponse(resp.status, {
        error: 'Falha na API de IA',
        details: data,
        model,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(502, { error: `Falha de comunicacao com a API de IA: ${msg}` });
  } finally {
    clearTimeout(timeout);
  }

  if (!finalResp) {
    return jsonResponse(503, {
      error: 'Nenhum modelo de IA acessivel para o token configurado',
      code: lastErrorCode || 'model_unavailable',
      triedModels,
    });
  }

  const text = extractText(finalData?.choices?.[0]?.message?.content).trim();
  if (!text) {
    return jsonResponse(502, { error: 'Resposta da IA vazia ou invalida' });
  }

  return jsonResponse(200, { text });
});
