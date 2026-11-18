// Cadastros auxiliares: profissionais, fornecedores, convênios e procedimentos (CRUD genérico).
import { api } from '../api.js';
import { html, render, $, on, money, centsToInput, badge, table, formDialog, toast, showError, fresh } from '../ui.js';
import { can } from '../state.js';

const yesNo = [{ value: 'true', label: 'Ativo' }, { value: 'false', label: 'Inativo' }];
const CONFIG = {
  professionals: {
    title: 'Médicos e profissionais', url: '/professionals', singular: 'profissional',
    columns: [{ label: 'Nome', key: 'name' }, { label: 'Tipo', key: 'kind' }, { label: 'Conselho', render: (r) => [r.council, r.council_number, r.council_state].filter(Boolean).join(' ') || '—' },
      { label: 'Especialidade', render: (r) => r.specialty || '—' }],
    fields: (r) => [
      { name: 'name', label: 'Nome', required: true, value: r.name, span2: true },
      { name: 'kind', label: 'Tipo', type: 'select', value: r.kind || 'MEDICO', options: ['MEDICO', 'ENFERMEIRO', 'TECNICO', 'FISIOTERAPEUTA', 'PSICOLOGO', 'NUTRICIONISTA', 'OUTRO'].map((v) => ({ value: v, label: v })) },
      { name: 'council', label: 'Conselho (CRM, COREN…)', value: r.council }, { name: 'council_number', label: 'Nº registro', value: r.council_number },
      { name: 'council_state', label: 'UF do conselho', value: r.council_state }, { name: 'specialty', label: 'Especialidade', value: r.specialty },
      { name: 'cpf', label: 'CPF', value: r.cpf }, { name: 'email', label: 'E-mail', value: r.email }, { name: 'phone', label: 'Telefone', value: r.phone },
    ],
  },
  suppliers: {
    title: 'Fornecedores', url: '/suppliers', singular: 'fornecedor',
    columns: [{ label: 'Razão social', key: 'name' }, { label: 'Fantasia', render: (r) => r.trade_name || '—' }, { label: 'CNPJ', render: (r) => r.cnpj || '—' }, { label: 'Categoria', render: (r) => r.category || '—' }],
    fields: (r) => [
      { name: 'name', label: 'Razão social', required: true, value: r.name, span2: true }, { name: 'trade_name', label: 'Nome fantasia', value: r.trade_name },
      { name: 'cnpj', label: 'CNPJ', value: r.cnpj }, { name: 'category', label: 'Categoria', value: r.category },
      { name: 'email', label: 'E-mail', value: r.email }, { name: 'phone', label: 'Telefone', value: r.phone },
    ],
  },
  insurance_plans: {
    title: 'Convênios e planos de saúde', url: '/insurance-plans', singular: 'convênio',
    columns: [{ label: 'Nome', key: 'name' }, { label: 'Registro ANS', render: (r) => r.ans_code || '—' }, { label: 'Tipo', render: (r) => r.plan_type || '—' }],
    fields: (r) => [
      { name: 'name', label: 'Nome', required: true, value: r.name, span2: true }, { name: 'ans_code', label: 'Registro ANS', value: r.ans_code },
      { name: 'cnpj', label: 'CNPJ', value: r.cnpj }, { name: 'plan_type', label: 'Tipo de plano', value: r.plan_type },
      { name: 'phone', label: 'Telefone', value: r.phone }, { name: 'email', label: 'E-mail', value: r.email },
    ],
  },
  procedures: {
    title: 'Procedimentos e exames', url: '/procedures', singular: 'procedimento',
    columns: [{ label: 'Código', key: 'code' }, { label: 'Nome', key: 'name' }, { label: 'Categoria', key: 'category' }, { label: 'Preço particular', class: 'money', render: (r) => money(r.price_cents) },
      { label: 'Fiscal', render: (r) => (r.national_tax_code ? html`<span class="small">cTribNac ${r.national_tax_code} · ISS ${(r.iss_rate_bp ?? 0) / 100}%</span>` : html`<span class="badge warn">sem regra fiscal</span>`) },
      { label: 'TUSS', render: (r) => r.tuss_code || '—' }],
    fields: (r) => [
      { name: 'code', label: 'Código', required: true, value: r.code }, { name: 'name', label: 'Nome do exame/serviço', required: true, value: r.name, span2: true },
      { name: 'category', label: 'Categoria', type: 'select', value: r.category || 'EXAME', options: ['EXAME', 'CONSULTA', 'LABORATORIO', 'IMAGEM', 'PROCEDIMENTO', 'TAXA', 'MATERIAL', 'MEDICAMENTO'].map((v) => ({ value: v, label: v })) },
      { name: 'price_cents', label: 'Preço particular (R$)', type: 'money', required: true, value: centsToInput(r.price_cents), placeholder: '500,00' },
      { name: 'description', label: 'Descrição', type: 'textarea', value: r.description, full: true },
      { name: 'service_list_item', label: 'Item LC 116/2003', value: r.service_list_item, placeholder: '04.02' },
      { name: 'national_tax_code', label: 'Código de tributação nacional (NFS-e)', value: r.national_tax_code, placeholder: '040201' },
      { name: 'nbs_code', label: 'Código NBS', value: r.nbs_code }, { name: 'iss_rate_bp', label: 'Alíquota ISS (pontos-base, 200 = 2%)', type: 'number', value: r.iss_rate_bp },
      { name: 'tuss_code', label: 'Código TUSS (faturamento)', value: r.tuss_code }, { name: 'billing_notes', label: 'Informações de faturamento', type: 'textarea', value: r.billing_notes, full: true },
    ],
  },
};

export function registry(entity) {
  const cfg = CONFIG[entity];
  return async function page(host) {
    const el = fresh(host);
    const manage = can('registry.manage');
    render(el, html`
      <div class="page-head"><div><h1>${cfg.title}</h1></div>${manage ? html`<button class="btn primary" data-new>+ Novo ${cfg.singular}</button>` : ''}</div>
      <div class="card"><div class="filters"><div class="span2"><label>Pesquisa</label><input type="search" data-q></div>
        <div><label>Situação</label><select data-active><option value="">Todos</option><option value="true">Ativos</option><option value="false">Inativos</option></select></div>
        <div><button class="btn" data-search>Filtrar</button></div></div></div>
      <div class="card" data-list></div>`);
    let rows = [];
    const load = async () => {
      rows = await api.get(cfg.url, { q: $('[data-q]', el).value.trim(), active: $('[data-active]', el).value });
      render($('[data-list]', el), table([...cfg.columns, { label: 'Situação', render: (r) => badge(r.active ? 'ATIVO' : 'INATIVO') },
        { label: '', render: (r) => (manage ? html`<button class="btn sm" data-edit="${r.id}">Editar</button>` : '') }], rows));
    };
    const open = (r = {}) => formDialog({
      title: r.id ? `Editar ${cfg.singular}` : `Novo ${cfg.singular}`, wide: true,
      fields: [...cfg.fields(r), ...(r.id ? [{ name: 'active', label: 'Situação', type: 'select', value: String(r.active), options: yesNo }] : [])],
      onSubmit: async (v) => {
        const body = { ...v };
        if (body.active !== undefined && body.active !== null) body.active = body.active === 'true';
        if (entity === 'procedures' && Number.isNaN(body.price_cents)) throw new Error('Preço inválido.');
        for (const k of Object.keys(body)) if (body[k] === null && !r.id) delete body[k];
        if (r.id) await api.put(`${cfg.url}/${r.id}`, body); else await api.post(cfg.url, body);
        toast('Cadastro salvo.', 'ok'); await load();
      },
    });
    $('[data-new]', el)?.addEventListener('click', () => open());
    $('[data-search]', el).addEventListener('click', () => load().catch(showError));
    on(el, 'click', '[data-edit]', (e, b) => open(rows.find((x) => String(x.id) === b.dataset.edit)));
    await load();
  };
}
