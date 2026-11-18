import { api } from '../api.js';
import { html, render, $$, money, datetime, badge, label, setWidth, fresh } from '../ui.js';
import { demoBanner } from '../components.js';
import { can } from '../state.js';

export async function dashboard(host) {
  const el = fresh(host);
  const d = await api.get('/dashboard');
  const max = Math.max(1, ...d.receivedByMethod30d.map((m) => Number(m.v)));
  render(el, html`
    ${demoBanner()}
    <div class="page-head"><div><h1>Painel inicial</h1><div class="muted">Visão geral do dia</div></div>
      <div class="btn-group">
        ${can('appointments.open') ? html`<a class="btn primary" href="#/atendimentos/novo">+ Novo atendimento</a>` : ''}
        ${can('patients.create') ? html`<a class="btn" href="#/pacientes?novo=1">+ Novo paciente</a>` : ''}
      </div>
    </div>
    <div class="grid k4">
      <div class="card kpi"><div class="label">Atendimentos hoje</div><div class="value">${d.appointmentsToday}</div><div class="sub">${d.schedulesToday} agendamento(s) pendente(s)</div></div>
      <div class="card kpi"><div class="label">Recebido hoje (confirmado)</div><div class="value">${money(d.receivedToday.cents)}</div><div class="sub">${d.receivedToday.count} pagamento(s)</div></div>
      <div class="card kpi"><div class="label">Contas pendentes</div><div class="value">${d.pendingAccounts.count}</div><div class="sub">${money(d.pendingAccounts.cents)} em aberto</div></div>
      <div class="card kpi"><div class="label">Parcialmente pagas</div><div class="value">${d.partialAccounts.count}</div><div class="sub">${money(d.partialAccounts.cents)} de saldo</div></div>
      <div class="card kpi ${d.awaitingConference ? 'alert' : ''}"><div class="label">Aguardando conferência</div><div class="value">${d.awaitingConference}</div><div class="sub">pagamentos manuais</div></div>
      <div class="card kpi ${d.fiscalRejected ? 'alert' : ''}"><div class="label">Fiscal</div><div class="value">${d.fiscalPending} / ${d.fiscalRejected}</div><div class="sub">pendentes / rejeitadas</div></div>
      <div class="card kpi ${d.reconciliationOpen ? 'alert' : ''}"><div class="label">Divergências de conciliação</div><div class="value">${d.reconciliationOpen}</div><div class="sub">em aberto</div></div>
    </div>
    <div class="grid c2 mt">
      <div class="card"><h2>Últimos atendimentos</h2>
        ${d.lastAppointments.length ? html`<table><thead><tr><th>Atendimento</th><th>Paciente</th><th class="money">Total</th><th>Conta</th></tr></thead><tbody>
          ${d.lastAppointments.map((a) => html`<tr><td><a href="#/contas/${a.account_id}">${a.number}</a><div class="small muted">${datetime(a.opened_at)}</div></td><td>${a.patient_name}</td><td class="money">${money(a.total_cents)}</td><td>${badge(a.financial_status)}</td></tr>`)}
        </tbody></table>` : html`<div class="empty">Sem atendimentos.</div>`}
      </div>
      <div class="card"><h2>Recebimentos por forma (30 dias)</h2>
        ${d.receivedByMethod30d.length ? d.receivedByMethod30d.map((m) => html`<div class="mb"><div class="row between"><span>${label(m.method)}</span><strong>${money(m.v)}</strong></div><div class="bar"><span data-w="${Math.round((Number(m.v) / max) * 100)}"></span></div></div>`) : html`<div class="empty">Sem recebimentos confirmados.</div>`}
      </div>
    </div>`);
  $$('[data-w]', el).forEach((s) => setWidth(s, Number(s.dataset.w)));
}
