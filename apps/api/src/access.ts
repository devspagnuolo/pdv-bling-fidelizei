import type { AuthPrincipal } from './auth.js';

export const isSupervisor = (principal?: AuthPrincipal) => principal?.role === 'MANAGER' || principal?.role === 'ADMIN';

// Operadores só acessam vendas e caixas próprios; gerente e administrador acessam todos.
export const canAccessOperatorResource = (authEnabled: boolean, principal: AuthPrincipal | undefined, ownerId: string | undefined) =>
  !authEnabled || isSupervisor(principal) || (principal !== undefined && principal.operatorId === ownerId);

// Rascunhos podem ser descartados pelo próprio operador. Pedidos que já passaram do
// atendimento estornam contas e estoque no Bling e exigem gerente.
export const reversalRequiresSupervisor = (status: string) => status !== 'OPEN';
