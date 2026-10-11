'use strict';
/** Catálogo de permissões e perfis padrão (controle de acesso por função). */
const PERMISSIONS = {
  'patients.view': 'Consultar pacientes',
  'patients.create': 'Cadastrar pacientes',
  'patients.edit': 'Editar pacientes',
  'patients.view_sensitive': 'Ver dados pessoais completos (CPF, contato)',
  'records.view': 'Consultar prontuário e histórico de atendimentos',
  'registry.view': 'Consultar cadastros (médicos, fornecedores, convênios, procedimentos)',
  'registry.manage': 'Manter cadastros',
  'scheduling.view': 'Consultar agenda',
  'scheduling.manage': 'Gerenciar agenda',
  'appointments.view': 'Consultar atendimentos',
  'appointments.open': 'Abrir atendimentos',
  'appointments.cancel': 'Cancelar atendimentos',
  'accounts.view': 'Consultar contas',
  'accounts.edit_items': 'Lançar procedimentos na conta',
  'accounts.adjust_price': 'Ajustar preço / conceder desconto ou acréscimo',
  'accounts.remove_item': 'Cancelar item da conta',
  'accounts.check': 'Conferir conta',
  'payments.view': 'Consultar pagamentos e comprovantes',
  'payments.receive': 'Iniciar recebimentos',
  'payments.confer': 'Conferir pagamentos informados manualmente',
  'payments.refund': 'Estornar pagamentos',
  'payments.reassign': 'Reatribuir pagamento associado à conta errada',
  'settlement.view': 'Consultar quitação',
  'billing.view': 'Consultar faturamento',
  'billing.manage': 'Fechar contas para faturamento',
  'fiscal.view': 'Consultar documentos fiscais',
  'fiscal.manage': 'Preparar e emitir NFS-e',
  'fiscal.cancel': 'Cancelar NFS-e',
  'reconciliation.view': 'Consultar conciliação',
  'reconciliation.manage': 'Executar conciliação e tratar divergências',
  'reports.view': 'Consultar relatórios',
  'reports.export': 'Exportar relatórios (CSV)',
  'users.manage': 'Gerenciar usuários e perfis',
  'audit.view': 'Consultar auditoria',
  'settings.manage': 'Configurações e integrações',
  'demo.simulate': 'Usar simulações do modo de demonstração',
};

const ALL = Object.keys(PERMISSIONS);

const DEFAULT_ROLES = [
  {
    code: 'recepcao', name: 'Recepção',
    permissions: ['patients.view', 'patients.create', 'patients.edit', 'patients.view_sensitive', 'records.view', 'registry.view',
      'scheduling.view', 'scheduling.manage', 'appointments.view', 'appointments.open', 'accounts.view', 'accounts.edit_items',
      'payments.view', 'payments.receive', 'settlement.view', 'demo.simulate'],
  },
  {
    code: 'caixa', name: 'Caixa',
    permissions: ['patients.view', 'appointments.view', 'accounts.view', 'accounts.check', 'payments.view', 'payments.receive',
      'payments.confer', 'settlement.view', 'demo.simulate'],
  },
  {
    code: 'faturamento', name: 'Faturamento',
    permissions: ['patients.view', 'registry.view', 'appointments.view', 'accounts.view', 'accounts.edit_items', 'accounts.adjust_price',
      'accounts.remove_item', 'accounts.check', 'payments.view', 'settlement.view', 'billing.view', 'billing.manage', 'reports.view'],
  },
  {
    code: 'financeiro', name: 'Financeiro',
    permissions: ['patients.view', 'appointments.view', 'accounts.view', 'accounts.check', 'payments.view', 'payments.confer',
      'payments.refund', 'payments.reassign', 'settlement.view', 'reconciliation.view', 'reconciliation.manage', 'reports.view',
      'reports.export', 'audit.view', 'billing.view'],
  },
  {
    code: 'fiscal', name: 'Fiscal',
    permissions: ['patients.view', 'patients.view_sensitive', 'appointments.view', 'accounts.view', 'payments.view', 'settlement.view',
      'fiscal.view', 'fiscal.manage', 'fiscal.cancel', 'reports.view', 'reports.export', 'demo.simulate'],
  },
  { code: 'admin', name: 'Administração', permissions: ALL },
];

module.exports = { PERMISSIONS, ALL, DEFAULT_ROLES };
