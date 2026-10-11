'use strict';
/**
 * Geração da DPS (Declaração de Prestação de Serviço) da NFS-e Nacional, a partir do snapshot
 * do documento fiscal. Usada tanto na integração quanto na EXPORTAÇÃO para outro sistema.
 * ATENÇÃO: conferir o leiaute vigente publicado no Portal Nacional da NFS-e antes de produção.
 */
const { centsToDecimal } = require('../../lib/money');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name, value) => (value === null || value === undefined || value === '' ? '' : `<${name}>${esc(value)}</${name}>`);

function dpsId(doc) {
  const p = doc.provider_data;
  return 'DPS' + String(p.cityIbgeCode || '').padStart(7, '0') + '2' + String(p.cnpj || '').padStart(14, '0')
    + String(doc.dps_series).padStart(5, '0') + String(doc.dps_number).padStart(15, '0');
}

function buildDpsXml(doc, { environment = '2', now = new Date() } = {}) {
  const p = doc.provider_data; const t = doc.taker; const s = doc.service;
  const competence = now.toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
<infDPS Id="${dpsId(doc)}">
${tag('tpAmb', environment)}${tag('dhEmi', now.toISOString().replace(/\.\d{3}Z$/, '-00:00'))}${tag('verAplic', 'SaudeGestao-1.0')}
${tag('serie', doc.dps_series)}${tag('nDPS', doc.dps_number)}${tag('dCompet', competence)}${tag('tpEmit', '1')}${tag('cLocEmi', p.cityIbgeCode)}
<prest>${tag('CNPJ', p.cnpj)}${tag('IM', p.municipalRegistration)}<regTrib>${tag('opSimpNac', p.simplesNacional ? '3' : '1')}${tag('regEspTrib', '0')}</regTrib></prest>
<toma>${t.cpf ? tag('CPF', t.cpf) : tag('CNPJ', t.cnpj)}${tag('IM', t.municipalRegistration)}${tag('xNome', t.name)}${t.cityIbgeCode ? `<end><endNac>${tag('cMun', t.cityIbgeCode)}${tag('CEP', t.zipCode)}</endNac>${tag('xLgr', t.address)}${tag('nro', t.addressNumber || 'S/N')}${tag('xBairro', t.district)}</end>` : ''}${tag('email', t.email)}</toma>
<serv><locPrest>${tag('cLocPrestacao', p.cityIbgeCode)}</locPrest><cServ>${tag('cTribNac', s.nationalTaxCode)}${tag('xDescServ', s.description)}${tag('cNBS', s.nbsCode)}</cServ>${doc.observations ? `<infoCompl>${tag('xInfComp', doc.observations)}</infoCompl>` : ''}</serv>
<valores><vServPrest>${tag('vServ', centsToDecimal(doc.amount_cents))}</vServPrest><trib><tribMun>${tag('tribISSQN', '1')}${tag('tpRetISSQN', '1')}${s.issRateBp != null ? tag('pAliq', (s.issRateBp / 100).toFixed(2)) : ''}</tribMun><totTrib>${tag('indTotTrib', '0')}</totTrib></trib></valores>
</infDPS>
</DPS>`;
}

module.exports = { buildDpsXml, dpsId };
