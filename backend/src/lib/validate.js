'use strict';
/**
 * Validação de entrada no servidor (nunca confiar no frontend).
 * Uso: const v = validator(req.body); const name = v.string('name', { required: true, max: 160 });
 *      v.done(); // lança 400 com todos os erros encontrados
 */
const { badRequest } = require('./errors');
const { toCents } = require('./money');

function validator(source = {}) {
  const errors = {};
  const src = source && typeof source === 'object' ? source : {};
  const missing = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

  const api = {
    errors,
    string(field, { required = false, max = 255, min = 0, pattern, label = field, trim = true } = {}) {
      let v = src[field];
      if (missing(v)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      if (typeof v !== 'string' && typeof v !== 'number') { errors[field] = `${label} inválido.`; return null; }
      v = String(v); if (trim) v = v.trim();
      if (v.length > max) errors[field] = `${label} deve ter no máximo ${max} caracteres.`;
      else if (v.length < min) errors[field] = `${label} deve ter no mínimo ${min} caracteres.`;
      else if (pattern && !pattern.test(v)) errors[field] = `${label} em formato inválido.`;
      return v;
    },
    digits(field, { required = false, length, label = field } = {}) {
      const raw = src[field];
      if (missing(raw)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      const v = String(raw).replace(/\D/g, '');
      if (length && v.length !== length) errors[field] = `${label} deve ter ${length} dígitos.`;
      return v;
    },
    int(field, { required = false, min, max, label = field } = {}) {
      const raw = src[field];
      if (missing(raw)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      const v = Number(raw);
      if (!Number.isSafeInteger(v)) { errors[field] = `${label} deve ser um número inteiro.`; return null; }
      if (min !== undefined && v < min) errors[field] = `${label} deve ser no mínimo ${min}.`;
      if (max !== undefined && v > max) errors[field] = `${label} deve ser no máximo ${max}.`;
      return v;
    },
    id(field, opts = {}) { return api.int(field, { min: 1, ...opts }); },
    cents(field, { required = false, allowZero = false, label = field } = {}) {
      const raw = src[field];
      if (missing(raw)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      try {
        const c = Number.isInteger(raw) ? raw : toCents(raw, label);
        if (c < 0 || (!allowZero && c === 0)) { errors[field] = `${label} deve ser maior que zero.`; return null; }
        return c;
      } catch (e) { errors[field] = e.message; return null; }
    },
    oneOf(field, values, { required = false, label = field } = {}) {
      const v = src[field];
      if (missing(v)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      if (!values.includes(v)) { errors[field] = `${label} deve ser um de: ${values.join(', ')}.`; return null; }
      return v;
    },
    bool(field, { def = null } = {}) {
      const v = src[field];
      if (v === undefined || v === null || v === '') return def;
      return v === true || v === 'true' || v === 1 || v === '1';
    },
    date(field, { required = false, label = field } = {}) {
      const v = src[field];
      if (missing(v)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) { errors[field] = `${label} deve estar no formato AAAA-MM-DD.`; return null; }
      return String(v);
    },
    datetime(field, { required = false, label = field } = {}) {
      const v = src[field];
      if (missing(v)) { if (required) errors[field] = `${label} é obrigatório.`; return null; }
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) { errors[field] = `${label} inválido.`; return null; }
      return d.toISOString();
    },
    fail(field, message) { errors[field] = message; },
    done() {
      if (Object.keys(errors).length) throw badRequest('Dados inválidos.', errors);
    },
  };
  return api;
}

module.exports = { validator };
