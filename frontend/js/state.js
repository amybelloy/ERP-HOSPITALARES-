// Estado da sessão no navegador (somente dados não sensíveis do usuário logado).
export const state = { user: null, demoMode: false };
export const can = (...perms) => !!state.user && perms.some((p) => state.user.permissions.includes(p));
