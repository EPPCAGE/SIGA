// Supabase Edge Function: send-alert-email
// Envia e-mails de alerta via Brevo (https://brevo.com)
//
// Variáveis de ambiente necessárias no painel Supabase:
//   BREVO_API_KEY — chave de API do Brevo

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const FROM_EMAIL    = 'f.ctourinho@gmail.com';
const FROM_NAME     = 'EPP · CAGE-RS';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
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
    console.error('[send-alert-email] BREVO_API_KEY não configurada');
    return new Response(
      JSON.stringify({ error: 'Serviço de e-mail não configurado. Configure BREVO_API_KEY.' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body: { to?: string; nome?: string; subject?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Corpo inválido — esperado JSON' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { to, subject, html } = body;

  if (!to || !subject || !html) {
    return new Response(
      JSON.stringify({ error: 'Campos obrigatórios: to, subject, html' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return new Response(
      JSON.stringify({ error: `Endereço de e-mail inválido: ${to}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const brevoPayload = {
    sender:  { name: FROM_NAME, email: FROM_EMAIL },
    to:      [{ email: to }],
    subject: subject,
    htmlContent: html,
  };

  const brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'api-key':      BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(brevoPayload),
  });

  const brevoData = await brevoResp.json();

  if (!brevoResp.ok) {
    console.error('[send-alert-email] Brevo error:', brevoData);
    return new Response(
      JSON.stringify({ error: 'Falha ao enviar e-mail', details: brevoData }),
      { status: brevoResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[send-alert-email] Enviado para ${to} — MessageId: ${brevoData.messageId}`);
  return new Response(
    JSON.stringify({ ok: true, id: brevoData.messageId }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
