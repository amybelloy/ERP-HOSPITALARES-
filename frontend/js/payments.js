// Fluxos de recebimento, conferência, estorno, reatribuição e comprovante.
import { api } from './api.js';
import { html, render, $, modal, money, centsToInput, toCents, datetime, label, badge, toast, busy, formDialog, confirmDialog } from './ui.js';
import { can, state } from './state.js';

const METHODS = [['PIX', 'Pix'], ['CARTAO_CREDITO', 'Cartão de crédito'], ['CARTAO_DEBITO', 'Cartão de débito'], ['DINHEIRO', 'Dinheiro'], ['BOLETO', 'Boleto bancário'], ['OUTRO', 'Outro meio']];

/** Tela de recebimento vinculada à conta. */
export function openReceive(account, onChange) {
  const inFlight = account.payments.filter((p) => ['PENDENTE', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA'].includes(p.status)).reduce((s, p) => s + p.amount_cents, 0);
  const available = account.balance_cents - inFlight;
  const body = document.createElement('div');
  render(body, html`
    <div class="totals mb">
      <div class="t"><div class="l">Valor total</div><div class="v">${money(account.total_cents)}</div></div>
      <div class="t"><div class="l">Já recebido</div><div class="v">${money(account.received_cents)}</div></div>
      <div class="t balance"><div class="l">Saldo restante</div><div class="v">${money(account.balance_cents)}</div></div>
    </div>
    ${inFlight ? html`<div class="alert warn mb">Há ${money(inFlight)} em cobranças em andamento. Disponível para nova cobrança: <strong>${money(available)}</strong>.</div>` : ''}
    <div class="form-grid">
      <div><label>Forma de pagamento</label><select name="method">${METHODS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
      <div><label>Valor a receber (R$)</label><input name="amount" value="${centsToInput(Math.max(available, 0))}"></div>
      <div class="hidden" data-card><label>Integração</label><select name="card_mode"><option value="TERMINAL">Enviar ao terminal (maquininha integrada)</option><option value="MANUAL">Registrar manualmente (sem integração)</option></select></div>
      <div class="hidden" data-inst><label>Parcelas</label><select name="installments">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => html`<option value="${n}">${n}x</option>`)}</select></div>
      <div class="hidden" data-ref><label>NSU / código de autorização *</label><input name="manual_reference" placeholder="Conforme comprovante do terminal"></div>
      <div class="hidden" data-other><label>Descrição do meio *</label><input name="method_label" placeholder="Ex.: transferência TED"></div>
      <div class="hidden" data-due><label>Vencimento do boleto</label><input type="date" name="due_date" value="${new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)}"></div>
    </div>
    <div class="alert info mt small" data-hint></div>`);
  const sel = (n) => body.querySelector(`[name=${n}]`);
  const update = () => {
    const m = sel('method').value; const card = m.startsWith('CARTAO'); const manualCard = card && sel('card_mode').value === 'MANUAL';
    $('[data-card]', body).classList.toggle('hidden', !card);
    $('[data-inst]', body).classList.toggle('hidden', m !== 'CARTAO_CREDITO');
    $('[data-ref]', body).classList.toggle('hidden', !manualCard);
    $('[data-other]', body).classList.toggle('hidden', m !== 'OUTRO');
    $('[data-due]', body).classList.toggle('hidden', m !== 'BOLETO');
    $('[data-hint]', body).textContent = m === 'BOLETO'
      ? 'Será registrado um boleto no banco em nome do paciente. A conta só é quitada quando o banco confirmar o pagamento.'
      : m === 'PIX'
      ? 'Será gerada uma cobrança Pix (QR Code dinâmico / Copia e Cola). A conta só é quitada após a confirmação do banco.'
      : card && !manualCard ? 'O valor será enviado ao terminal. A aprovação é registrada automaticamente quando o terminal/adquirente confirmar.'
        : 'Pagamento informado manualmente: ficará AGUARDANDO CONFERÊNCIA por outro usuário autorizado antes de contar na conta. Comprovantes fotografados não são aceitos como confirmação única.';
  };
  ['method', 'card_mode'].forEach((n) => sel(n).addEventListener('change', update)); update();
  modal({ title: `Receber — conta ${account.number}`, wide: true, body, actions: [
    { label: 'Cancelar' },
    { label: 'Iniciar recebimento', class: 'primary', onClick: async ({ close }) => {
      const cents = toCents(sel('amount').value);
      if (!cents || Number.isNaN(cents)) throw new Error('Valor inválido.');
      const m = sel('method').value;
      const p = await api.post(`/accounts/${account.id}/payments`, {
        method: m, amount_cents: cents, card_mode: m.startsWith('CARTAO') ? sel('card_mode').value : undefined,
        installments: m === 'CARTAO_CREDITO' ? Number(sel('installments').value) : 1,
        manual_reference: sel('manual_reference').value || undefined, method_label: sel('method_label').value || undefined,
        due_date: m === 'BOLETO' ? sel('due_date').value || undefined : undefined,
      });
      close();
      openPaymentFlow(p.id, onChange);
      return false;
    } },
  ] });
}

/** Acompanha um pagamento até a confirmação (QR Pix, terminal ou conferência). */
export async function openPaymentFlow(paymentId, onChange) {
  let p = await api.get(`/payments/${paymentId}`);
  const body = document.createElement('div');
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const draw = () => {
    const done = !['PENDENTE', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA'].includes(p.status);
    render(body, html`
      ${p.is_demo ? html`<div class="alert demo mb">DEMONSTRAÇÃO — provedor simulado. Nenhum valor real será cobrado.</div>` : ''}
      <div class="row between mb"><div><strong>${label(p.method)}</strong> · ${money(p.amount_cents)} · conta ${p.account_number}</div><div>${badge(p.status)}</div></div>
      ${p.method === 'PIX' && p.status === 'PENDENTE' ? html`<div class="qr">
          ${p.pix_qr_code ? html`<img alt="QR Code Pix" src="${p.pix_qr_code}">` : ''}
          <div class="stack"><div><label>Pix Copia e Cola</label><div class="copy-paste mono" data-cp>${p.pix_copy_paste || '—'}</div></div>
            <button class="btn sm" data-copy>Copiar código</button>
            <div class="small muted">Expira em: ${datetime(p.expires_at)} · txid <span class="mono">${p.provider_charge_id}</span></div>
            <div class="waiting"><div class="spinner"></div> Aguardando confirmação do banco…</div></div></div>` : ''}
      ${p.method === 'BOLETO' && p.status === 'PENDENTE' ? html`<div class="stack"><div><label>Linha digitável</label><div class="copy-paste mono">${p.boleto_digitable_line || '—'}</div></div>
          <div class="small muted">Nosso número ${p.provider_charge_id} · vencimento ${p.boleto_due_date ? new Date(`${p.boleto_due_date.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '—'}</div>
          <div class="btn-group"><button class="btn sm" data-print-boleto>Imprimir boleto</button><button class="btn sm" data-copy-line>Copiar linha</button></div>
          <div class="waiting"><div class="spinner"></div> Aguardando confirmação de pagamento pelo banco…</div></div>` : ''}
      ${p.status === 'PROCESSANDO' ? html`<div class="waiting"><div class="spinner"></div> Transação enviada ao terminal. Aguardando o cliente e a resposta da adquirente…</div>` : ''}
      ${p.status === 'AGUARDANDO_CONFERENCIA' ? html`<div class="alert warn">Pagamento registrado manualmente${p.manual_reference ? ` (ref. ${p.manual_reference})` : ''}. Aguardando conferência por outro usuário com permissão. A conta ainda NÃO foi atualizada.</div>` : ''}
      ${p.status === 'CONFIRMADO' ? html`<div class="alert ok">Pagamento confirmado (${label(p.confirmation_source)}) em ${datetime(p.confirmed_at)}. Conta: ${badge(p.financial_status)} — recebido ${money(p.account_received_cents)} de ${money(p.account_total_cents)}.</div>` : ''}
      ${['REJEITADO', 'CANCELADO', 'EXPIRADO', 'DIVERGENTE', 'FALHA_COMUNICACAO'].includes(p.status) ? html`<div class="alert danger">${label(p.status)}${p.status_reason ? `: ${p.status_reason}` : ''}. A conta não foi quitada por este pagamento.</div>` : ''}
      ${!done && p.is_demo && can('demo.simulate') ? html`<div class="card mt"><h3>Simulação (somente demonstração)</h3><div class="btn-group">
          ${p.method === 'BOLETO' ? html`<button class="btn demo" data-sim-boleto>Simular pagamento do boleto</button>` : ''}
          ${p.method === 'PIX' ? html`<button class="btn demo" data-sim="PAGAR">Simular pagamento Pix pelo pagador</button><button class="btn demo" data-sim="EXPIRAR">Simular expiração</button>` : ''}
          ${p.method === 'BOLETO' && p.status === 'PENDENTE' ? html`<div class="stack"><div><label>Linha digitável</label><div class="copy-paste mono">${p.boleto_digitable_line || '—'}</div></div>
          <div class="small muted">Nosso número ${p.provider_charge_id} · vencimento ${p.boleto_due_date ? new Date(`${p.boleto_due_date.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '—'}</div>
          <div class="btn-group"><button class="btn sm" data-print-boleto>Imprimir boleto</button><button class="btn sm" data-copy-line>Copiar linha</button></div>
          <div class="waiting"><div class="spinner"></div> Aguardando confirmação de pagamento pelo banco…</div></div>` : ''}
      ${p.status === 'PROCESSANDO' ? html`<button class="btn demo" data-card="APROVADA">Simular cartão APROVADO</button><button class="btn demo" data-card="NEGADA">Simular cartão NEGADO</button>` : ''}
        </div><p class="small muted">A simulação altera apenas o provedor simulado e dispara o mesmo webhook/consulta usado em produção.</p></div>` : ''}
    `);
    if (done) stop();
  };
  const refresh = async () => { const r = await api.post(`/payments/${paymentId}/refresh`); p = r.payment; draw(); };
  body.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.copy !== undefined) { await navigator.clipboard?.writeText(p.pix_copy_paste); toast('Código copiado.', 'ok'); }
    if (t.dataset.copyLine !== undefined) { await navigator.clipboard?.writeText((p.boleto_digitable_line || '').replace(/\D/g, '')); toast('Linha copiada.', 'ok'); }
    if (t.dataset.printBoleto !== undefined) { const m = await import('./pages/boletos.js'); m.printBoleto(p.id); }
    if (t.dataset.simBoleto !== undefined) await busy(t, async () => { const r = await api.post(`/demo/payments/${paymentId}/boleto`, {}); p = r.payment; draw(); onChange?.(); });
    if (t.dataset.sim) await busy(t, async () => { const r = await api.post(`/demo/payments/${paymentId}/pix`, { outcome: t.dataset.sim }); p = r.payment; draw(); onChange?.(); });
    if (t.dataset.card) await busy(t, async () => { const r = await api.post(`/demo/payments/${paymentId}/card`, { outcome: t.dataset.card }); p = r.payment; draw(); onChange?.(); });
  });
  draw();
  if (['PENDENTE', 'PROCESSANDO'].includes(p.status)) timer = setInterval(() => refresh().catch(() => {}), 4000);
  modal({ title: `Pagamento #${p.id}`, wide: true, body, onClose: () => { stop(); onChange?.(); }, actions: [
    { label: 'Consultar status no provedor', closes: false, onClick: async () => { await refresh(); return false; } },
    ...(can('payments.receive') ? [{ label: 'Cancelar cobrança', class: 'danger', closes: false, onClick: async ({ close }) => {
      if (!['PENDENTE', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA'].includes(p.status)) throw new Error('Cobrança não pode ser cancelada neste status.');
      // eslint-disable-next-line no-alert
      const reason = window.prompt('Motivo do cancelamento da cobrança:'); if (!reason) return false;
      p = await api.post(`/payments/${paymentId}/cancel`, { reason }); draw(); toast('Cobrança cancelada.', 'ok'); close(); return false;
    } }] : []),
    { label: 'Fechar', class: 'primary' },
  ] });
}

export function openConfer(payment, onChange) {
  formDialog({
    title: `Conferir pagamento #${payment.id}`,
    intro: html`<div class="alert warn">${label(payment.method)} de <strong>${money(payment.amount_cents)}</strong> registrado por ${payment.created_by_name}${payment.manual_reference ? ` · ref. ${payment.manual_reference}` : ''}. Confira o valor com o caixa/relatório do terminal antes de aprovar.</div>`,
    fields: [{ name: 'decision', label: 'Decisão', type: 'select', options: [{ value: 'true', label: 'Aprovar — valor conferido' }, { value: 'false', label: 'Rejeitar — valor não conferido' }] },
      { name: 'note', label: 'Observação (obrigatória para rejeitar)', type: 'textarea', full: true }],
    submit: 'Registrar conferência',
    onSubmit: async (v) => { await api.post(`/payments/${payment.id}/confer`, { approve: v.decision === 'true', note: v.note }); toast('Conferência registrada.', 'ok'); onChange?.(); },
  });
}

export function openRefund(payment, onChange) {
  const max = payment.amount_cents - payment.refunded_cents;
  formDialog({
    title: `Estornar pagamento #${payment.id}`,
    intro: html`<div class="alert warn">Estornável: <strong>${money(max)}</strong>. O estorno é auditável e reabre a conta conforme o novo saldo. ${payment.method === 'PIX' ? 'Para Pix, será solicitada a devolução ao banco.' : ''}</div>`,
    fields: [{ name: 'amount', label: 'Valor do estorno (R$)', value: centsToInput(max) }, { name: 'reason', label: 'Motivo *', type: 'textarea', full: true }],
    submit: 'Estornar',
    onSubmit: async (v) => {
      const r = await api.post(`/payments/${payment.id}/refund`, { amount_cents: toCents(v.amount), reason: v.reason });
      toast(r.message || 'Estorno registrado.', r.message ? 'warn' : 'ok'); onChange?.();
    },
  });
}

export function openReassign(payment, onChange) {
  formDialog({
    title: `Reatribuir pagamento #${payment.id}`,
    intro: html`<div class="alert warn">Use somente quando o pagamento foi associado por engano a esta conta. A operação move o valor para a conta correta e fica registrada na auditoria.</div>`,
    fields: [{ name: 'account_number', label: 'Número da conta de destino (ex.: CTA0000005)', required: true }, { name: 'reason', label: 'Justificativa *', type: 'textarea', full: true }],
    submit: 'Reatribuir',
    onSubmit: async (v) => {
      const found = await api.get('/accounts', { account_number: v.account_number });
      if (!found.length) throw new Error('Conta de destino não encontrada.');
      if (!(await confirmDialog(`Mover ${money(payment.amount_cents)} para a conta ${found[0].number} (${found[0].patient_name})?`))) return;
      await api.post(`/payments/${payment.id}/reassign`, { target_account_id: found[0].id, reason: v.reason });
      toast('Pagamento reatribuído.', 'ok'); onChange?.();
    },
  });
}

export async function openReceipt(paymentId) {
  const r = await api.get(`/payments/${paymentId}/receipt`);
  const inst = r.institution || {};
  modal({ title: 'Comprovante interno de recebimento', wide: true, body: html`<div class="print-area print-doc">
      <div class="row between"><div><strong>${inst.name || 'Instituição'}</strong><div class="small">CNPJ ${inst.cnpj || '—'} · ${inst.address || ''} ${inst.city || ''}/${inst.state || ''}</div></div><div class="small">Emitido em ${datetime(new Date().toISOString())}</div></div>
      <div class="doc-title">COMPROVANTE INTERNO DE RECEBIMENTO</div>
      ${r.is_demo ? html`<div class="watermark">DEMONSTRAÇÃO — SEM VALOR REAL</div>` : ''}
      <dl class="kv">
        <dt>Paciente</dt><dd>${r.patient_name} (${r.patient_code}) · Prontuário ${r.record_number}</dd>
        <dt>Atendimento</dt><dd>${r.appointment_number}</dd><dt>Conta</dt><dd>${r.account_number}</dd>
        <dt>Valor recebido</dt><dd><strong>${money(r.amount_cents)}</strong>${r.refunded_cents ? ` (estornado ${money(r.refunded_cents)})` : ''}</dd>
        <dt>Forma de pagamento</dt><dd>${label(r.method)}${r.method_label ? ` — ${r.method_label}` : ''}${r.installments > 1 ? ` · ${r.installments}x` : ''}</dd>
        <dt>Data e hora</dt><dd>${datetime(r.confirmed_at)}</dd>
        <dt>Identificador da transação</dt><dd class="mono">${r.transaction_id || '—'}</dd>
        <dt>Cobrança / provedor</dt><dd class="mono">${r.provider_charge_id || '—'} · ${r.provider}</dd>
        <dt>Situação</dt><dd>${label(r.status)} · confirmação: ${label(r.confirmation_source)}</dd>
        <dt>Recebido por</dt><dd>${r.received_by}${r.conferred_by ? ` · conferido por ${r.conferred_by}` : ''}</dd>
      </dl>
      <div class="disclaimer">${r.disclaimer}</div>
      <div class="small muted">O comprovante bancário é emitido pelo banco/app do pagador; o comprovante do cartão é emitido pelo terminal. A NFS-e, quando emitida, é o documento fiscal.</div>
    </div>`, actions: [{ label: 'Fechar' }, { label: 'Imprimir', class: 'primary', closes: false, onClick: () => { window.print(); return false; } }] });
}

export { state };
