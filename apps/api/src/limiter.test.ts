import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttemptLimiter } from './limiter.js';

test('bloqueia após o máximo de falhas e libera ao fim da janela', () => {
  const limiter = new AttemptLimiter(3, 1_000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(limiter.blocked('op:1', 0), false);
    limiter.fail('op:1', 0);
  }
  assert.equal(limiter.blocked('op:1', 500), true);
  assert.equal(limiter.blocked('op:2', 500), false);
  assert.equal(limiter.blocked('op:1', 1_001), false);
});

test('login certo zera o contador da chave', () => {
  const limiter = new AttemptLimiter(2, 1_000);
  limiter.fail('op:1', 0);
  limiter.reset('op:1');
  limiter.fail('op:1', 0);
  assert.equal(limiter.blocked('op:1', 0), false);
});

test('não guarda mais chaves que o limite', () => {
  const limiter = new AttemptLimiter(1, 60_000, 10);
  for (let index = 0; index < 50; index += 1) limiter.fail(`ip:${index}`, 0);
  assert.equal(limiter.blocked('ip:49', 0), true);
  assert.equal(limiter.blocked('ip:0', 0), false);
});
