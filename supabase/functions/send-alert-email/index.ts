import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FROM_EMAIL = 'f.ctourinho@gmail.com';
const FROM_NAME = 'EPP CAGE-RS';

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

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const token = getBearerToken(req);
  const requesterEmail = decodeJwtEmail(token);
  if (!token || !requesterEmail) {
    return jsonResponse(401, { error: 'Token invalido ou ausente' });
  }

  const allowed = await isEditor(requesterEmail);
  if (!allowed) {
    return jsonResponse(403, { error: 'Apenas editores podem disparar alertas' });
  }

  if (!BREVO_API_KEY) {
    return jsonResponse(503, { error: 'BREVO_API_KEY nao configurada' });
  }

  let body: { to?: string; subject?: string; html?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse(400, { error: 'Corpo invalido' });
  }

  const { to, subject, html } = body;

  if (!to || !subject || !html) {
    return jsonResponse(400, { error: 'Campos obrigatorios: to, subject, html' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return jsonResponse(400, { error: 'Email invalido: ' + to });
  }

  if (subject.length > 180) {
    return jsonResponse(400, { error: 'Assunto muito longo (max 180 caracteres)' });
  }

  if (html.length > 50000) {
    return jsonResponse(400, { error: 'Corpo HTML muito grande (max 50KB)' });
  }

  const payload = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: to }],
    subject: subject,
    htmlContent: html,
  };

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_e) {
    data = { raw };
  }

  if (!resp.ok) {
    console.error('[send-alert-email] Brevo error:', data);
    return jsonResponse(resp.status, { error: 'Falha ao enviar email', details: data });
  }

  console.log('[send-alert-email] Solicitado por ' + requesterEmail + ' | Enviado para ' + to + ' - MessageId: ' + data.messageId);
  return jsonResponse(200, { ok: true, id: data.messageId });
});
