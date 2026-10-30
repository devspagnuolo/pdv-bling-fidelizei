import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { authConfigured, authenticatePin, hashPin, issueToken, validPinFormat, verifyPinHash, verifyToken } from './auth.js';

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });
const configure = (extra: Record<string, string> = {}) => {
  Object.assign(process.env, { PDV_AUTH_SECRET: 'segredo-de-teste', PDV_OPERATOR_PIN: '111111', PDV_MANAGER_PIN: '222222', PDV_ADMIN_PIN: '999999' }, extra);
  delete process.env.PDV_REQUIRE_INDIVIDUAL_PIN;
  Object.assign(process.env, extra);
};

test('PIN individual é guardado com hash e conferido', () => {
  const stored = hashPin('482915');
  assert.ok(!stored.includes('482915'));
  assert.equal(verifyPinHash('482915', stored), true);
  assert.equal(verifyPinHash('482916', stored), false);
  assert.notEqual(hashPin('482915'), stored, 'cada hash usa um salt novo');
});

test('formato de PIN exige de 6 a 12 dígitos', () => {
  assert.equal(validPinFormat('12345'), false);
  assert.equal(validPinFormat('123456'), true);
  assert.equal(validPinFormat('12345a'), false);
  assert.equal(validPinFormat('1234567890123'), false);
});

test('PINs compartilhados valem até exigir PIN individual', () => {
  configure();
  assert.equal(authenticatePin('111111'), 'OPERATOR');
  assert.equal(authenticatePin('222222'), 'MANAGER');
  assert.equal(authenticatePin('999999'), 'ADMIN');
  assert.equal(authenticatePin(''), undefined);
  configure({ PDV_REQUIRE_INDIVIDUAL_PIN: '1' });
  assert.equal(authenticatePin('111111'), undefined);
  assert.equal(authenticatePin('222222'), undefined);
  assert.equal(authenticatePin('999999'), 'ADMIN');
});

test('com PIN individual obrigatório, os PINs compartilhados não são necessários', () => {
  process.env.PDV_AUTH_SECRET = 'x';
  delete process.env.PDV_OPERATOR_PIN;
  delete process.env.PDV_MANAGER_PIN;
  delete process.env.PDV_REQUIRE_INDIVIDUAL_PIN;
  assert.equal(authConfigured(), false);
  process.env.PDV_REQUIRE_INDIVIDUAL_PIN = '1';
  assert.equal(authConfigured(), true);
});

test('token assinado carrega identificador e rejeita adulteração', () => {
  configure();
  const token = issueToken({ operatorId: '7', operatorName: 'Ana', role: 'OPERATOR' });
  const principal = verifyToken(token);
  assert.equal(principal?.operatorId, '7');
  assert.ok(principal?.jti);
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...principal, role: 'MANAGER' })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${signature}`), undefined);
  assert.equal(verifyToken(`${payload}.x${signature.slice(1)}`), undefined);
});
