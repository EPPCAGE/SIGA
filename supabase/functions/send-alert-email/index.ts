// Supabase Edge Function: send-alert-email
// Envia e-mails de alerta via Resend (https://resend.com)
//
// Variáveis de ambiente necessárias no painel Supabase:
//   RESEND_API_KEY  — chave de API do Resend (ex: re_xxxxxxxxxx)
//   FROM_EMAIL      — endereço remetente verificado no Resend (ex: alertas@seudominio.gov.br)
//                     Se não configurado, usa o endereço padrão do Resend para testes.
//
// Como configurar:
//   1. Crie uma conta em https://resend.com (plano gratuito: 3.000 e-mails/mês)
//   2. Verifique seu domínio ou use o domínio de teste do Resend
//   3. Gere uma API key e adicione como secret no Supabase:
//      supabase secrets set RESEND_API_KEY=re_xxxxxxxxxx
//      supabase secrets set FROM_EMAIL=alertas@cage.rs.gov.br
//   4. Deploy: supabase functions deploy send-alert-email

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL     = Deno.env.get('FROM_EMAIL') ?? 'onboarding@resend.dev';
const FROM_NAME      = Deno.env.get('FROM_NAME')  ?? 'EPP · CAGE-RS';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  if (!RESEND_API_KEY) {
    console.error('[send-alert-email] RESEND_API_KEY não configurada');
    return new Response(
      JSON.stringify({ error: 'Serviço de e-mail não configurado. Configure RESEND_API_KEY.' }),
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

  const { to, nome, subject, html } = body;

  if (!to || !subject || !html) {
    return new Response(
      JSON.stringify({ error: 'Campos obrigatórios: to, subject, html' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Basic e-mail validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return new Response(
      JSON.stringify({ error: `Endereço de e-mail inválido: ${to}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const resendPayload = {
    from:    `${FROM_NAME} <${FROM_EMAIL}>`,
    to:      [to],
    subject: subject,
    html:    html,
  };

  const resendResp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(resendPayload),
  });

  const resendData = await resendResp.json();

  if (!resendResp.ok) {
    console.error('[send-alert-email] Resend error:', resendData);
    return new Response(
      JSON.stringify({ error: 'Falha ao enviar e-mail', details: resendData }),
      { status: resendResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[send-alert-email] Enviado para ${to} — ID: ${resendData.id}`);
  return new Response(
    JSON.stringify({ ok: true, id: resendData.id }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
