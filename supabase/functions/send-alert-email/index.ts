import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const FROM_EMAIL = 'f.ctourinho@gmail.com';
const FROM_NAME = 'EPP CAGE-RS';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  if (!BREVO_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'BREVO_API_KEY nao configurada' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body: { to?: string; subject?: string; html?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: 'Corpo invalido' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { to, subject, html } = body;

  if (!to || !subject || !html) {
    return new Response(
      JSON.stringify({ error: 'Campos obrigatorios: to, subject, html' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return new Response(
      JSON.stringify({ error: 'Email invalido: ' + to }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
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

  const data = await resp.json();

  if (!resp.ok) {
    console.error('[send-alert-email] Brevo error:', data);
    return new Response(
      JSON.stringify({ error: 'Falha ao enviar email', details: data }),
      { status: resp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log('[send-alert-email] Enviado para ' + to + ' - MessageId: ' + data.messageId);
  return new Response(
    JSON.stringify({ ok: true, id: data.messageId }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
