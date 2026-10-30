import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAccessOperatorResource, reversalRequiresSupervisor } from './access.js';

const principal = (role: 'OPERATOR' | 'MANAGER' | 'ADMIN', operatorId = '1') => ({ operatorId, operatorName: 'Teste', role, exp: 0 });

test('operador acessa apenas as próprias vendas e caixas', () => {
  assert.equal(canAccessOperatorResource(true, principal('OPERATOR', '1'), '1'), true);
  assert.equal(canAccessOperatorResource(true, principal('OPERATOR', '1'), '2'), false);
  assert.equal(canAccessOperatorResource(true, undefined, '1'), false);
});

test('gerente e administrador acessam qualquer venda', () => {
  assert.equal(canAccessOperatorResource(true, principal('MANAGER', '1'), '2'), true);
  assert.equal(canAccessOperatorResource(true, principal('ADMIN', 'admin'), '2'), true);
});

test('sem autenticação configurada (ambiente local) não há restrição', () => {
  assert.equal(canAccessOperatorResource(false, undefined, '2'), true);
});

test('estornar pedido que saiu do atendimento exige gerente', () => {
  assert.equal(reversalRequiresSupervisor('OPEN'), false);
  for (const status of ['COMPLETED', 'RECONCILIATION_REQUIRED', 'SYNC_FAILED']) assert.equal(reversalRequiresSupervisor(status), true);
});
