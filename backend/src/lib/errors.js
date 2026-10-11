'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, details) => new AppError(400, 'VALIDACAO', msg, details);
const unauthorized = (msg = 'Autenticação necessária.') => new AppError(401, 'NAO_AUTENTICADO', msg);
const forbidden = (msg = 'Você não tem permissão para esta operação.') => new AppError(403, 'SEM_PERMISSAO', msg);
const notFound = (msg = 'Registro não encontrado.') => new AppError(404, 'NAO_ENCONTRADO', msg);
const conflict = (msg, details) => new AppError(409, 'CONFLITO', msg, details);
const unprocessable = (msg, details) => new AppError(422, 'REGRA_DE_NEGOCIO', msg, details);
const providerError = (msg, details) => new AppError(502, 'FALHA_PROVEDOR', msg, details);
const notConfigured = (msg) => new AppError(503, 'INTEGRACAO_NAO_CONFIGURADA', msg);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, unprocessable, providerError, notConfigured };
