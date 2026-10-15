import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fidelizei } from './live.js';

test('prévia Fidelizei calcula percentual e valor fixo sem consumir cupom', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIDELIZEI_API_KEY;
  process.env.FIDELIZEI_API_KEY = 'test-key';
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const fixed = requests.length === 2;
    return new Response(JSON.stringify({ data: {
      id: fixed ? 'fixed-id' : 'percent-id',
      status: 'ready_for_use',
      reward: { name: fixed ? 'R$ 10' : '10%', discountType: fixed ? 'fixed' : 'percent', discountValue: fixed ? 1000 : 10, minimumOrderCents: 0 },
      customer: { cpf: '52998224725' }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const percent = await fidelizei.previewCoupon('FZ-PERCENT', 'sale-1', 100, '52998224725');
    const fixed = await fidelizei.previewCoupon('FZ-FIXED', 'sale-2', 100, '52998224725');
    assert.equal(percent.coupon.discount, 10);
    assert.equal(fixed.coupon.discount, 10);
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/public/v1/redemptions/preview', '/public/v1/redemptions/preview']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FIDELIZEI_API_KEY;
    else process.env.FIDELIZEI_API_KEY = originalKey;
  }
});

test('recompensa sem regra é recusada na prévia', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIDELIZEI_API_KEY;
  process.env.FIDELIZEI_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: {
      status: 'ready_for_use', reward: { discountType: null, discountValue: null, minimumOrderCents: 0 }, customer: { cpf: '52998224725' }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(fidelizei.previewCoupon('FZ-INVALID', 'sale-3', 100, '52998224725'), /regra de desconto válida/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FIDELIZEI_API_KEY;
    else process.env.FIDELIZEI_API_KEY = originalKey;
  }
});
