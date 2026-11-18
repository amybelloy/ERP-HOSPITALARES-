'use strict';
/** Relatórios financeiros/fiscais. Cada relatório define colunas (para CSV) e uma consulta. */
const { pool } = require('../db/pool');
const { centsToDecimal } = require('../lib/money');
const { badRequest } = require('../lib/errors');

const money = (k) => (r) => centsToDecimal(Number(r[k] || 0)).replace('.', ',');
const dt = (k) => (r) => (r[k] ? new Date(r[k]).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');

const range = (alias) => `${alias} >= $1::date AND ${alias} < ($2::date + interval '1 day')`;

const REPORTS = {
  'recebimentos-periodo': {
    title: 'Recebimentos por período (dia)',
    sql: `SELECT date_trunc('day', confirmed_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia, count(*)::int AS quantidade,
                 SUM(amount_cents)::bigint AS bruto_cents, SUM(refunded_cents)::bigint AS estornado_cents, SUM(amount_cents - refunded_cents)::bigint AS liquido_cents
            FROM payments WHERE confirmed_at IS NOT NULL AND ${range('confirmed_at')} GROUP BY 1 ORDER BY 1`,
    columns: [{ key: 'dia', label: 'Dia' }, { key: 'quantidade', label: 'Quantidade' }, { label: 'Bruto (R$)', value: money('bruto_cents') },
      { label: 'Estornado (R$)', value: money('estornado_cents') }, { label: 'Líquido (R$)', value: money('liquido_cents') }],
  },
  'recebimentos-forma': {
    title: 'Recebimentos por forma de pagamento',
    sql: `SELECT method AS forma, count(*)::int AS quantidade, SUM(amount_cents - refunded_cents)::bigint AS liquido_cents, bool_or(is_demo) AS contem_demo
            FROM payments WHERE confirmed_at IS NOT NULL AND ${range('confirmed_at')} GROUP BY 1 ORDER BY 3 DESC`,
    columns: [{ key: 'forma', label: 'Forma' }, { key: 'quantidade', label: 'Quantidade' }, { label: 'Líquido (R$)', value: money('liquido_cents') },
      { label: 'Contém demonstração', value: (r) => (r.contem_demo ? 'SIM' : 'NÃO') }],
  },
  'contas-status': {
    title: 'Contas por status (pendentes, parciais, quitadas)',
    params: ['status'],
    sql: `SELECT ac.number AS conta, ap.number AS atendimento, p.name AS paciente, ac.financial_status AS status, ac.total_cents, ac.received_cents,
                 (ac.total_cents - ac.received_cents) AS saldo_cents, ap.opened_at, ac.settled_at
            FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients p ON p.id = ac.patient_id
           WHERE ${range('ap.opened_at')} AND ($3::text IS NULL OR ac.financial_status = $3) ORDER BY ap.opened_at DESC`,
    columns: [{ key: 'conta', label: 'Conta' }, { key: 'atendimento', label: 'Atendimento' }, { key: 'paciente', label: 'Paciente' }, { key: 'status', label: 'Status' },
      { label: 'Total (R$)', value: money('total_cents') }, { label: 'Recebido (R$)', value: money('received_cents') }, { label: 'Saldo (R$)', value: money('saldo_cents') },
      { label: 'Abertura', value: dt('opened_at') }, { label: 'Quitação', value: dt('settled_at') }],
  },
  'notas-fiscais': {
    title: 'Documentos fiscais (emitidos, pendentes, rejeitados, cancelados)',
    params: ['status'],
    sql: `SELECT fd.id, ac.number AS conta, fd.status, fd.mode AS modo, fd.is_demo, fd.nfse_number, fd.amount_cents, fd.taker->>'name' AS tomador,
                 fd.rejection_reason, fd.requested_at, fd.processed_at
            FROM fiscal_documents fd JOIN accounts ac ON ac.id = fd.account_id
           WHERE ${range('fd.requested_at')} AND ($3::text IS NULL OR fd.status = $3) ORDER BY fd.id DESC`,
    columns: [{ key: 'id', label: 'ID' }, { key: 'conta', label: 'Conta' }, { key: 'status', label: 'Status' }, { key: 'modo', label: 'Modo' },
      { label: 'Demonstração', value: (r) => (r.is_demo ? 'SIM - SEM VALIDADE FISCAL' : 'NÃO') }, { key: 'nfse_number', label: 'Número' },
      { label: 'Valor (R$)', value: money('amount_cents') }, { key: 'tomador', label: 'Tomador' }, { key: 'rejection_reason', label: 'Motivo rejeição' },
      { label: 'Solicitado', value: dt('requested_at') }, { label: 'Processado', value: dt('processed_at') }],
  },
  conciliacao: {
    title: 'Conciliação bancária (itens)',
    sql: `SELECT b.id, r.id AS execucao, b.category AS categoria, b.status, ac.number AS conta, b.expected_cents, b.found_cents, b.description, b.resolution_note, b.created_at
            FROM bank_reconciliation b JOIN reconciliation_runs r ON r.id = b.run_id LEFT JOIN accounts ac ON ac.id = b.account_id
           WHERE ${range('b.created_at')} ORDER BY b.id DESC`,
    columns: [{ key: 'execucao', label: 'Execução' }, { key: 'categoria', label: 'Categoria' }, { key: 'status', label: 'Status' }, { key: 'conta', label: 'Conta' },
      { label: 'Esperado (R$)', value: money('expected_cents') }, { label: 'Encontrado (R$)', value: money('found_cents') },
      { key: 'description', label: 'Descrição' }, { key: 'resolution_note', label: 'Parecer' }],
  },
  'cancelamentos-estornos': {
    title: 'Cancelamentos e estornos',
    sql: `SELECT t.kind AS tipo, t.provider_transaction_id AS referencia, ac.number AS conta, t.amount_cents, t.source AS origem, t.occurred_at, u.name AS usuario
            FROM payment_transactions t JOIN accounts ac ON ac.id = t.account_id LEFT JOIN users u ON u.id = t.created_by
           WHERE t.kind IN ('ESTORNO','CANCELAMENTO','REATRIBUICAO','REJEICAO') AND ${range('t.occurred_at')}
          UNION ALL
          SELECT 'ITEM_CANCELADO', ai.description, ac.number, ai.total_cents, ai.cancel_reason, ai.cancelled_at, u.name
            FROM account_items ai JOIN accounts ac ON ac.id = ai.account_id LEFT JOIN users u ON u.id = ai.cancelled_by
           WHERE ai.status = 'CANCELADO' AND ${range('ai.cancelled_at')}
          ORDER BY 6 DESC`,
    columns: [{ key: 'tipo', label: 'Tipo' }, { key: 'referencia', label: 'Referência' }, { key: 'conta', label: 'Conta' }, { label: 'Valor (R$)', value: money('amount_cents') },
      { key: 'origem', label: 'Origem/Motivo' }, { label: 'Data', value: dt('occurred_at') }, { key: 'usuario', label: 'Usuário' }],
  },
  'operacoes-usuario': {
    title: 'Operações por usuário',
    sql: `SELECT COALESCE(u.name, a.user_email, 'sistema') AS usuario, a.action AS operacao, count(*)::int AS quantidade, max(a.occurred_at) AS ultima
            FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${range('a.occurred_at')} GROUP BY 1,2 ORDER BY 1, 3 DESC`,
    columns: [{ key: 'usuario', label: 'Usuário' }, { key: 'operacao', label: 'Operação' }, { key: 'quantidade', label: 'Quantidade' }, { label: 'Última', value: dt('ultima') }],
  },
};

async function run(type, { from, to, status } = {}) {
  const def = REPORTS[type];
  if (!def) throw badRequest('Relatório inexistente.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw badRequest('Informe o período (from/to no formato AAAA-MM-DD).');
  const params = [from, to];
  if (def.params?.includes('status')) params.push(status || null);
  const { rows } = await pool.query(def.sql, params);
  return { type, title: def.title, columns: def.columns.map((c) => c.label), rows, def };
}

const list = () => Object.entries(REPORTS).map(([key, d]) => ({ key, title: d.title, params: d.params || [] }));

module.exports = { run, list, REPORTS };
