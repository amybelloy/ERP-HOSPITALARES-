import { api } from '../api.js';
import { html, render, $, on, money, datetime, badge, label, table, showError, busy, toast, formDialog, modal, fresh } from '../ui.js';
import { can, state } from '../state.js';

export async function fiscal(host, { params }) {
  const el = fresh(host);
  const integ = await api.get('/integrations').catch(() => null);
  const active = integ?.fiscal?.find((f) => f.active);
  const isDemo = !active || active.demo;
  const manage = can('fiscal.manage');
  render(el, html`
    ${isDemo ? html`<div class="demo-banner">⚠ Integração fiscal em DEMONSTRAÇÃO: nada é transmitido à prefeitura/Ambiente Nacional e NENHUMA nota fiscal oficial é emitida. Documentos gerados aqui não têm validade fiscal.</div>`
    : html`<div class="alert info mb">Provedor fiscal ativo: <strong>${active.name}</strong>${active.configured ? '' : ' (configuração incompleta)'}.</div>`}
    <div class="page-head"><div><h1>Emissão e consulta de notas fiscais (NFS-e)</h1><div class="muted">Status fiscal é independente do status financeiro.</div></div></div>
    <div class="tabs"><button data-tab="eligible" class="active">Contas elegíveis</button><button data-tab="docs">Documentos</button>${state.demoMode && can('demo.simulate') ? html`<button data-tab="demo">Simulação</button>` : ''}</div>
    <div data-content></div>`);
  const content = $('[data-content]', el);
  let docs = [];

  const showEligible = async () => {
    const rows = await api.get('/fiscal/eligible');
    render(content, html`<div class="card"><p class="small muted">Contas QUITADAS sem documento fiscal ativo. Escolha emitir por integração ou apenas preparar os dados para outro sistema.</p>
      ${table([{ label: 'Conta', render: (a) => html`<a href="#/contas/${a.id}">${a.number}</a>` }, { label: 'Atendimento', key: 'appointment_number' }, { label: 'Tomador', render: (a) => html`${a.patient_name}${a.has_cpf ? '' : html` <span class="badge danger">sem CPF</span>`}` },
        { label: 'Serviço', render: (a) => a.procedures }, { label: 'Valor', class: 'money', render: (a) => money(a.total_cents) }, { label: 'Quitada em', render: (a) => datetime(a.settled_at) },
        { label: 'Status fiscal', render: (a) => badge(a.fiscal_status) },
        { label: '', render: (a) => (manage ? html`<div class="btn-group"><a class="btn sm primary" href="#/contas/${a.id}?etapa=nota">Abrir nota (escolher tomador)</a><button class="btn sm" data-prep="${a.id}" data-mode="INTEGRACAO">Emitir em nome do paciente${isDemo ? ' (demo)' : ''}</button><button class="btn sm" data-prep="${a.id}" data-mode="EXPORTACAO">Preparar p/ outro sistema</button></div>` : '') }],
      rows, { empty: 'Nenhuma conta elegível.' })}</div>`);
  };

  const showDocs = async (status = params.status || '') => {
    docs = await api.get('/fiscal/documents', { status });
    render(content, html`<div class="card"><div class="row mb"><label class="small">Status</label><select data-dstatus>${['', 'PREPARADA', 'ENVIADA', 'PROCESSANDO', 'EMITIDA', 'REJEITADA', 'CANCELADA', 'EXPORTADA', 'EMITIDA_EXTERNAMENTE', 'FALHA_COMUNICACAO'].map((s) => html`<option value="${s}" ${s === status ? 'selected' : ''}>${s ? label(s) : 'Todos'}</option>`)}</select></div>
      ${table([{ label: '#', key: 'id' }, { label: 'DPS', key: 'dps_number' }, { label: 'Conta', render: (d) => html`<a href="#/contas/${d.account_id}">${d.account_number}</a><div class="small muted">financeiro: ${label(d.financial_status)}</div>` },
        { label: 'Tomador', key: 'taker_name' }, { label: 'Valor', class: 'money', render: (d) => money(d.amount_cents) }, { label: 'Modo', render: (d) => label(d.mode) },
        { label: 'Status', render: (d) => html`${badge(d.status)}${d.is_demo ? html` <span class="badge demo">DEMO — sem validade fiscal</span>` : ''}${d.rejection_reason ? html`<div class="small muted">${d.rejection_reason}</div>` : ''}${['EMITIDA', 'EMITIDA_EXTERNAMENTE'].includes(d.status) && d.financial_status !== 'QUITADA' ? html`<div class="small"><span class="badge warn">Conta não está mais quitada</span></div>` : ''}` },
        { label: 'Número / verificação', render: (d) => (d.nfse_number ? html`${d.nfse_number}<div class="small muted">${d.verification_code || ''}</div>` : '—') },
        { label: 'Solicitado', render: (d) => datetime(d.requested_at) },
        { label: '', render: (d) => html`<div class="btn-group">
          <button class="btn sm" data-view="${d.id}">Conferir dados</button><a class="btn sm" href="#/contas/${d.account_id}?etapa=nota">Abrir na conta</a>
          ${manage && ['PREPARADA', 'FALHA_COMUNICACAO'].includes(d.status) ? html`<button class="btn sm primary" data-submit="${d.id}">${d.mode === 'EXPORTACAO' ? 'Gerar exportação' : d.status === 'FALHA_COMUNICACAO' ? 'Reenviar' : 'Enviar emissão'}</button>` : ''}
          ${['ENVIADA', 'PROCESSANDO'].includes(d.status) ? html`<button class="btn sm" data-check="${d.id}">Consultar resultado</button>` : ''}
          ${manage && ['EXPORTADA', 'EMITIDA_EXTERNAMENTE', 'PREPARADA'].includes(d.status) ? html`<a class="btn sm" href="/api/fiscal/documents/${d.id}/export?format=xml">XML DPS</a>` : ''}
          ${manage && d.status === 'EXPORTADA' ? html`<button class="btn sm" data-ext="${d.id}">Registrar emissão externa</button>` : ''}
          ${can('fiscal.cancel') && ['EMITIDA', 'EMITIDA_EXTERNAMENTE', 'PREPARADA', 'EXPORTADA'].includes(d.status) ? html`<button class="btn sm danger" data-cancel="${d.id}">Cancelar</button>` : ''}</div>` }],
      docs, { empty: 'Nenhum documento.' })}</div>`);
  };

  const showDemo = async () => {
    const s = await api.get('/demo/state');
    render(content, html`<div class="card"><h2>Resultado da próxima emissão simulada</h2><div class="btn-group">
      ${['EMITIR', 'PENDENTE', 'REJEITAR'].map((o) => html`<button class="btn ${s.fiscalNextOutcome === o ? 'primary' : ''}" data-outcome="${o}">${o === 'EMITIR' ? 'Emitir (simulado)' : o === 'PENDENTE' ? 'Ficar pendente' : 'Rejeitar'}</button>`)}</div>
      <p class="small muted">Use para demonstrar os cenários de emissão pendente e rejeitada.</p>
      <h2 class="mt">Falha de comunicação com o serviço fiscal</h2><button class="btn ${s.fiscalFailure ? 'danger' : ''}" data-ffail="${!s.fiscalFailure}">${s.fiscalFailure ? 'Desativar falha simulada' : 'Ativar falha simulada'}</button></div>`);
  };

  const tabs = { eligible: showEligible, docs: () => showDocs(), demo: showDemo };
  on(el, 'click', '[data-tab]', (e, b) => { el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b)); tabs[b.dataset.tab]().catch(showError); });
  on(content, 'change', '[data-dstatus]', (e, s) => showDocs(s.value).catch(showError));
  on(content, 'click', '[data-prep]', (e, b) => busy(b, async () => {
    const d = await api.post(`/fiscal/accounts/${b.dataset.prep}/prepare`, { mode: b.dataset.mode });
    toast(`Documento #${d.id} preparado (${label(d.mode)}). Confira os dados e envie.`, 'ok');
    el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'docs'));
    await showDocs();
  }));
  on(content, 'click', '[data-submit]', (e, b) => busy(b, async () => {
    const d = await api.post(`/fiscal/documents/${b.dataset.submit}/submit`);
    toast(`Resultado: ${label(d.status)}${d.is_demo ? ' (DEMONSTRAÇÃO — sem validade fiscal)' : ''}`, d.status === 'REJEITADA' || d.status === 'FALHA_COMUNICACAO' ? 'error' : 'ok');
    await showDocs();
  }));
  on(content, 'click', '[data-check]', (e, b) => busy(b, async () => { const d = await api.post(`/fiscal/documents/${b.dataset.check}/check`); toast(`Status: ${label(d.status)}`); await showDocs(); }));
  on(content, 'click', '[data-view]', (e, b) => busy(b, async () => {
    const d = await api.get(`/fiscal/documents/${b.dataset.view}`);
    modal({ title: `Documento fiscal #${d.id} — DPS ${d.dps_number}`, wide: true, body: html`
      ${d.is_demo ? html`<div class="alert demo mb">DEMONSTRAÇÃO — este documento NÃO é uma nota fiscal oficial.</div>` : ''}
      <div class="grid c2"><div><h3>Prestador</h3><dl class="kv"><dt>Razão social</dt><dd>${d.provider_data.name}</dd><dt>CNPJ</dt><dd>${d.provider_data.cnpj}</dd><dt>Município (IBGE)</dt><dd>${d.provider_data.cityIbgeCode}</dd><dt>Inscrição municipal</dt><dd>${d.provider_data.municipalRegistration || '—'}</dd></dl></div>
      <div><h3>Tomador</h3><dl class="kv"><dt>Nome</dt><dd>${d.taker.name}</dd><dt>CPF</dt><dd>${d.taker.cpf}</dd><dt>E-mail</dt><dd>${d.taker.email || '—'}</dd><dt>Município</dt><dd>${d.taker.city || '—'} ${d.taker.cityIbgeCode ? `(${d.taker.cityIbgeCode})` : ''}</dd></dl></div></div>
      <h3 class="mt">Serviço</h3><dl class="kv"><dt>Descrição</dt><dd>${d.service.description}</dd><dt>Cód. tributação nacional</dt><dd>${d.service.nationalTaxCode}</dd><dt>Item LC 116</dt><dd>${d.service.serviceListItem || '—'}</dd>
        <dt>Alíquota ISS</dt><dd>${d.service.issRateBp != null ? `${(d.service.issRateBp / 100).toFixed(2)}%` : '—'}</dd><dt>Valor</dt><dd><strong>${money(d.amount_cents)}</strong></dd></dl>
      <h3 class="mt">Processamento</h3><dl class="kv"><dt>Status</dt><dd>${badge(d.status)}</dd><dt>Status financeiro da conta</dt><dd>${badge(d.financial_status)}</dd>
        <dt>Número NFS-e</dt><dd>${d.nfse_number || '—'}</dd><dt>Código de verificação</dt><dd>${d.verification_code || '—'}</dd><dt>Chave de acesso</dt><dd class="mono">${d.access_key || '—'}</dd>
        <dt>Protocolo</dt><dd class="mono">${d.protocol || '—'}</dd><dt>Link oficial</dt><dd>${d.official_url ? html`<a href="${d.official_url}" target="_blank" rel="noopener">abrir</a>` : '—'}</dd>
        <dt>Motivo rejeição</dt><dd>${d.rejection_reason || '—'}</dd><dt>Cancelamento</dt><dd>${d.cancelled_at ? `${datetime(d.cancelled_at)} — ${d.cancel_reason}` : '—'}</dd></dl>` });
  }));
  on(content, 'click', '[data-ext]', (e, b) => formDialog({ title: 'Registrar emissão realizada em outro sistema',
    fields: [{ name: 'nfse_number', label: 'Número da NFS-e', required: true }, { name: 'verification_code', label: 'Código de verificação' }, { name: 'official_url', label: 'Link oficial (https://…)', full: true }],
    onSubmit: async (v) => { await api.post(`/fiscal/documents/${b.dataset.ext}/external`, v); toast('Emissão externa registrada.', 'ok'); await showDocs(); } }));
  on(content, 'click', '[data-cancel]', (e, b) => formDialog({ title: 'Cancelar documento fiscal', intro: html`<div class="alert warn">Para NFS-e emitida, o cancelamento é enviado ao serviço fiscal e segue as regras do município/Ambiente Nacional.</div>`,
    fields: [{ name: 'reason', label: 'Justificativa (mín. 15 caracteres)', type: 'textarea', full: true }],
    onSubmit: async (v) => { await api.post(`/fiscal/documents/${b.dataset.cancel}/cancel`, v); toast('Documento cancelado.', 'ok'); await showDocs(); } }));
  on(content, 'click', '[data-outcome]', (e, b) => busy(b, async () => { await api.post('/demo/fiscal-outcome', { outcome: b.dataset.outcome }); await showDemo(); }));
  on(content, 'click', '[data-ffail]', (e, b) => busy(b, async () => { await api.post('/demo/failure', { target: 'fiscal', enabled: b.dataset.ffail === 'true' }); await showDemo(); }));
  if (params.status) { el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'docs')); await showDocs(params.status); } else await showEligible();
}
