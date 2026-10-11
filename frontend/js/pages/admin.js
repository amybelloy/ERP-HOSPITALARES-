import { api } from '../api.js';
import { html, render, $, on, datetime, badge, table, showError, busy, toast, formDialog, modal, today, daysAgo, fresh } from '../ui.js';
import { state, can } from '../state.js';

// ------------------------------------------------------------------ 18. Usuários e permissões
export async function users(host) {
  const load = async () => {
    const el = fresh(host);
    const [list, { roles, permissions }] = await Promise.all([api.get('/users'), api.get('/roles')]);
    render(el, html`
      <div class="page-head"><div><h1>Usuários e permissões</h1><div class="muted">Controle de acesso por função (recepção, caixa, faturamento, financeiro, fiscal, administração)</div></div><button class="btn primary" data-new>+ Novo usuário</button></div>
      <div class="card">${table([{ label: 'Nome', key: 'name' }, { label: 'E-mail', key: 'email' }, { label: 'Perfil', key: 'role_name' },
        { label: 'Situação', render: (u) => html`${badge(u.active ? 'ATIVO' : 'INATIVO')}${u.locked_until && new Date(u.locked_until) > new Date() ? html` <span class="badge danger">bloqueado</span>` : ''}` },
        { label: 'Último acesso', render: (u) => datetime(u.last_login_at) }, { label: '', render: (u) => html`<button class="btn sm" data-edit="${u.id}">Editar</button>` }], list)}</div>
      <div class="card"><h2>Matriz de permissões por perfil</h2><div class="table-wrap"><table class="perm-matrix"><thead><tr><th>Permissão</th>${roles.map((r) => html`<th>${r.name}</th>`)}</tr></thead>
        <tbody>${Object.entries(permissions).map(([p, d]) => html`<tr><td>${d}<div class="small muted mono">${p}</div></td>${roles.map((r) => html`<td><input type="checkbox" data-perm="${p}" data-role="${r.id}" ${r.permissions.includes(p) ? 'checked' : ''}></td>`)}</tr>`)}</tbody></table></div>
        <div class="row end mt"><button class="btn primary" data-save-perms>Salvar permissões</button></div></div>`);
    const roleOpts = roles.map((r) => ({ value: r.id, label: r.name }));
    $('[data-new]', el).addEventListener('click', () => formDialog({ title: 'Novo usuário', fields: [
      { name: 'name', label: 'Nome', required: true }, { name: 'email', label: 'E-mail', type: 'email', required: true },
      { name: 'role_id', label: 'Perfil', type: 'select', options: roleOpts }, { name: 'password', label: 'Senha inicial', type: 'password', required: true, help: 'Mín. 10 caracteres com letras e números' }],
    onSubmit: async (v) => { await api.post('/users', v); toast('Usuário criado.', 'ok'); await load(); } }));
    on(el, 'click', '[data-edit]', (e, b) => {
      const u = list.find((x) => String(x.id) === b.dataset.edit);
      formDialog({ title: `Editar ${u.name}`, fields: [
        { name: 'name', label: 'Nome', value: u.name }, { name: 'role_id', label: 'Perfil', type: 'select', value: u.role_id, options: roleOpts },
        { name: 'active', label: 'Situação', type: 'select', value: String(u.active), options: [{ value: 'true', label: 'Ativo' }, { value: 'false', label: 'Inativo' }] },
        { name: 'password', label: 'Nova senha (opcional)', type: 'password', help: 'Alterar a senha encerra as sessões ativas do usuário' }],
      onSubmit: async (v) => {
        const body = { name: v.name, active: v.active === 'true', password: v.password || undefined };
        if (String(v.role_id) !== String(u.role_id)) body.role_id = v.role_id;
        if (u.id === state.user.id) { delete body.active; delete body.role_id; }
        await api.put(`/users/${u.id}`, body); toast('Usuário atualizado.', 'ok'); await load();
      } });
    });
    $('[data-save-perms]', el).addEventListener('click', (e) => busy(e.target, async () => {
      for (const r of roles) {
        const perms = [...el.querySelectorAll(`[data-role="${r.id}"]:checked`)].map((c) => c.dataset.perm);
        if (perms.sort().join() !== [...r.permissions].sort().join()) await api.put(`/roles/${r.id}`, { permissions: perms });
      }
      toast('Permissões salvas. Usuários afetados devem entrar novamente.', 'ok'); await load();
    }));
  };
  await load();
}

// ------------------------------------------------------------------ 19. Auditoria
export async function audit(host) {
  const el = fresh(host);
  render(el, html`
    <div class="page-head"><div><h1>Auditoria e histórico de operações</h1><div class="muted">Registros imutáveis de todas as operações relevantes</div></div></div>
    <div class="card"><div class="filters">
      <div><label>De</label><input type="date" data-f="from" value="${daysAgo(7)}"></div><div><label>Até</label><input type="date" data-f="to" value="${today()}"></div>
      <div><label>Entidade</label><select data-f="entity"><option value="">Todas</option>${['patients', 'appointments', 'accounts', 'payments', 'fiscal_documents', 'bank_reconciliation', 'users', 'roles', 'settings', 'procedures', 'professionals', 'reports'].map((x) => html`<option>${x}</option>`)}</select></div>
      <div><label>ID</label><input data-f="entity_id"></div><div><label>Ação contém</label><input data-f="action" placeholder="ex.: ESTORN"></div>
      <div><button class="btn primary" data-load>Filtrar</button></div></div></div>
    <div class="card" data-list></div>`);
  let rows = [];
  const load = async () => {
    const f = {}; el.querySelectorAll('[data-f]').forEach((i) => { f[i.dataset.f] = i.value.trim(); });
    rows = await api.get('/audit', f);
    render($('[data-list]', el), table([{ label: 'Data', render: (a) => datetime(a.occurred_at) }, { label: 'Usuário', render: (a) => a.user_name || a.user_email || 'sistema' },
      { label: 'Ação', render: (a) => html`<strong>${a.action}</strong>` }, { label: 'Entidade', render: (a) => `${a.entity} #${a.entity_id ?? ''}` },
      { label: 'IP', render: (a) => a.ip || '—' }, { label: '', render: (a) => html`<button class="btn sm" data-det="${a.id}">Detalhes</button>` }], rows));
  };
  on(el, 'click', '[data-det]', (e, b) => { const a = rows.find((x) => String(x.id) === b.dataset.det); modal({ title: a.action, wide: true, body: html`<pre class="mono">${JSON.stringify(a.details, null, 2)}</pre><div class="small muted">${a.user_agent || ''}</div>` }); });
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  await load();
}

// ------------------------------------------------------------------ 20. Configurações e integrações
export async function settings(host) {
  const el = fresh(host);
  const [cfg, integ, demo, events] = await Promise.all([api.get('/settings'), api.get('/integrations'), api.get('/demo/state'), api.get('/webhook-events', { limit: 30 })]);
  const inst = cfg.institution || {}; const fis = cfg.fiscal || {};
  const provRow = (p) => html`<tr><td><strong>${p.name}</strong>${p.active ? html` <span class="badge ok">ativo</span>` : ''}${p.demo ? html` <span class="badge demo">DEMONSTRAÇÃO</span>` : ''}</td>
    <td>${p.configured ? html`<span class="badge ok">configurado</span>` : html`<span class="badge warn">pendente</span>`}</td><td class="small">${p.missing?.length ? html`Faltam: <span class="mono">${p.missing.join(', ')}</span>` : '—'}</td></tr>`;
  render(el, html`
    <div class="page-head"><div><h1>Configurações e integrações</h1><div class="muted">Credenciais, certificados e tokens ficam SOMENTE em variáveis de ambiente do servidor.</div></div></div>
    <div class="grid c2">
      <div class="card"><h2>Instituição (prestador NFS-e)</h2><form class="form-grid" data-inst>
        <div class="span2"><label>Razão social</label><input name="name" value="${inst.name || ''}"></div><div><label>CNPJ</label><input name="cnpj" value="${inst.cnpj || ''}"></div>
        <div><label>Inscrição municipal</label><input name="municipalRegistration" value="${inst.municipalRegistration || ''}"></div><div><label>Código IBGE do município</label><input name="cityIbgeCode" value="${inst.cityIbgeCode || ''}"></div>
        <div><label>Cidade</label><input name="city" value="${inst.city || ''}"></div><div><label>UF</label><input name="state" value="${inst.state || ''}"></div>
        <div class="span2"><label>Endereço</label><input name="address" value="${inst.address || ''}"></div><div><label>Telefone</label><input name="phone" value="${inst.phone || ''}"></div>
        <div><label>Simples Nacional</label><select name="simplesNacional"><option value="false">Não</option><option value="true" ${inst.simplesNacional ? 'selected' : ''}>Sim</option></select></div>
        <div class="full row end"><button class="btn primary" type="submit">Salvar</button></div></form></div>
      <div class="card"><h2>Política fiscal</h2><form class="form-grid" data-fiscal>
        <div class="span2"><label>Modo padrão de emissão</label><select name="defaultMode"><option value="INTEGRACAO">Emitir automaticamente por integração</option><option value="EXPORTACAO" ${fis.defaultMode === 'EXPORTACAO' ? 'selected' : ''}>Apenas preparar dados para outro sistema</option></select></div>
        <div class="span2"><label>Exigir conta quitada para emissão</label><select name="requireSettled"><option value="true">Sim</option><option value="false" ${fis.requireSettled === false ? 'selected' : ''}>Não</option></select></div>
        <div class="full row end"><button class="btn primary" type="submit">Salvar</button></div></form>
        <p class="small muted">Ambas as opções ficam disponíveis por conta na tela fiscal.</p></div>
    </div>
    <div class="card"><h2>Integrações</h2>
      ${integ.demoMode ? html`<div class="alert demo mb">DEMO_MODE ativo: provedores simulados disponíveis. Em produção use DEMO_MODE=false.</div>` : ''}
      <table><thead><tr><th>Provedor</th><th>Situação</th><th>Pendências</th></tr></thead><tbody>
        <tr><th colspan="3">Pix (banco)</th></tr>${integ.pix.map(provRow)}
        <tr><th colspan="3">Cartão (maquininha / adquirente)</th></tr>${integ.card.map(provRow)}
        <tr><th colspan="3">Fiscal (NFS-e)</th></tr>${integ.fiscal.map(provRow)}</tbody></table>
      <p class="small muted mt">Webhook Pix: <span class="mono">${integ.webhookUrls.pix}</span> · Callback cartão: <span class="mono">${integ.webhookUrls.card}</span> · Conferência obrigatória de pagamentos manuais: <strong>${integ.manualPaymentsRequireConference ? 'sim' : 'não'}</strong></p></div>
    ${demo.demoMode && can('demo.simulate') ? html`<div class="card"><h2>Simulação de falhas (demonstração)</h2><div class="btn-group">
      <button class="btn ${demo.pixFailure ? 'danger' : ''}" data-fail="pix" data-on="${!demo.pixFailure}">${demo.pixFailure ? 'Restabelecer comunicação Pix' : 'Simular banco (Pix) fora do ar'}</button>
      <button class="btn ${demo.cardFailure ? 'danger' : ''}" data-fail="card" data-on="${!demo.cardFailure}">${demo.cardFailure ? 'Restabelecer terminal' : 'Simular terminal sem comunicação'}</button>
      <button class="btn ${demo.fiscalFailure ? 'danger' : ''}" data-fail="fiscal" data-on="${!demo.fiscalFailure}">${demo.fiscalFailure ? 'Restabelecer serviço fiscal' : 'Simular serviço fiscal fora do ar'}</button></div></div>` : ''}
    <div class="card"><div class="row between"><h2>Notificações recebidas (webhooks)</h2><button class="btn sm" data-retry>Reprocessar eventos com erro</button></div>
      ${table([{ label: '#', key: 'id' }, { label: 'Recebido', render: (e) => datetime(e.received_at) }, { label: 'Provedor', key: 'provider' }, { label: 'Chave', render: (e) => html`<span class="mono">${e.event_key}</span>` },
        { label: 'Assinatura', render: (e) => (e.signature_valid ? html`<span class="badge ok">válida</span>` : html`<span class="badge danger">inválida</span>`) },
        { label: 'Status', render: (e) => html`${badge(e.status)}${e.error ? html`<div class="small muted">${e.error}</div>` : ''}` }, { label: 'Tentativas', key: 'attempts' }], events, { empty: 'Nenhuma notificação recebida.' })}</div>`);
  const formObj = (f) => Object.fromEntries(new FormData(f).entries());
  $('[data-inst]', el).addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => { const v = formObj(e.target); await api.put('/settings/institution', { ...v, simplesNacional: v.simplesNacional === 'true' }); toast('Dados da instituição salvos.', 'ok'); }); });
  $('[data-fiscal]', el).addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => { const v = formObj(e.target); await api.put('/settings/fiscal', { defaultMode: v.defaultMode, requireSettled: v.requireSettled === 'true' }); toast('Política fiscal salva.', 'ok'); }); });
  on(el, 'click', '[data-fail]', (e, b) => busy(b, async () => { await api.post('/demo/failure', { target: b.dataset.fail, enabled: b.dataset.on === 'true' }); await settings(host); }));
  on(el, 'click', '[data-retry]', (e, b) => busy(b, async () => { const r = await api.post('/webhook-events/retry'); toast(`${r.length} evento(s) reprocessado(s).`, 'ok'); await settings(host); }));
}
