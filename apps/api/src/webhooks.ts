import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';

type BlingWebhook = {
  eventId: string;
  date?: string;
  version?: string;
  event: string;
  companyId: string;
  data: Record<string, unknown>;
};

const textValue = (value: unknown) => value === undefined || value === null ? undefined : String(value);
const numberValue = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const verifySignature = (rawBody: Buffer, supplied: string | undefined) => {
  const secret = process.env.BLING_CLIENT_SECRET;
  if (!secret || !supplied?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};
const processEvent = async (payload: BlingWebhook) => {
  if (!pool) throw new Error('Banco de dados indisponível');
  const [resource, action] = payload.event.split('.');
  const data = payload.data ?? {};
  if (resource === 'product') {
    const id = textValue(data.id);
    if (!id) throw new Error('Webhook de produto sem identificador');
    if (action === 'deleted') {
      await pool.query('delete from bling_products where id=$1', [id]);
      return;
    }
    const name = textValue(data.nome);
    if (!name) throw new Error('Webhook de produto sem nome');
    await pool.query(
      `insert into bling_products (id, sku, name, price, stock, barcode, synced_at)
       values ($1,$2,$3,$4,0,$5,now())
       on conflict (id) do update set
         sku=excluded.sku, name=excluded.name, price=excluded.price,
         barcode=coalesce(excluded.barcode, bling_products.barcode), synced_at=now()`,
      [id, textValue(data.codigo) ?? id, name, numberValue(data.preco), textValue(data.gtin)]
    );
    return;
  }
  if (resource === 'stock' || resource === 'virtual_stock') {
    const product = data.produto as Record<string, unknown> | undefined;
    const id = textValue(product?.id);
    if (!id) throw new Error('Webhook de estoque sem produto');
    const balance = numberValue(data.saldoVirtualTotal ?? data.saldoFisicoTotal);
    await pool.query('update bling_products set stock=$2, synced_at=now() where id=$1', [id, balance]);
    return;
  }
  if (resource === 'order') {
    const orderId = textValue(data.id);
    const storeNumber = textValue(data.numeroLoja);
    if (!orderId && !storeNumber) throw new Error('Webhook de pedido sem identificador');
    await pool.query(
      `update pdv_sales set
         data=jsonb_set(
           jsonb_set(data, '{blingOrderId}', to_jsonb(coalesce($1::text, data->>'blingOrderId'))),
           '{blingEvent}', $3::jsonb
         ),
         updated_at=now()
       where ($2::text is not null and data->>'id'=$2)
          or ($1::text is not null and data->>'blingOrderId'=$1)`,
      [orderId ?? null, storeNumber ?? null, JSON.stringify({ event: payload.event, date: payload.date, data })]
    );
    return;
  }
  // Eventos fiscais são preservados integralmente na fila para auditoria. A vinculação
  // ao pedido depende dos detalhes da nota e será feita pelo reconciliador fiscal.
};

const processNextEvent = async (app: FastifyInstance): Promise<boolean> => {
  if (!pool) return false;
  const claimed = await pool.query(
    `with candidate as (
       select event_id from bling_webhook_events
       where status in ('PENDING','FAILED') and next_attempt_at <= now() and attempts < 10
       order by received_at asc for update skip locked limit 1
     )
     update bling_webhook_events event set status='PROCESSING', attempts=attempts+1
     from candidate where event.event_id=candidate.event_id
     returning event.event_id as "eventId", event.payload, event.attempts`
  ) as { rows: { eventId: string; payload: BlingWebhook; attempts: number }[] };
  const item = claimed.rows[0];
  if (!item) return false;
  try {
    await processEvent(item.payload);
    await pool.query(
      `update bling_webhook_events set status='PROCESSED', processed_at=now(), last_error=null where event_id=$1`,
      [item.eventId]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha desconhecida';
    const status = item.attempts >= 10 ? 'DEAD' : 'FAILED';
    const delaySeconds = Math.min(3600, 15 * 2 ** Math.min(item.attempts, 8));
    await pool.query(
      `update bling_webhook_events set status=$2, last_error=$3,
        next_attempt_at=now()+($4::text || ' seconds')::interval where event_id=$1`,
      [item.eventId, status, message.slice(0, 1000), String(delaySeconds)]
    );
    app.log.error({ error, eventId: item.eventId, attempts: item.attempts, status }, 'Falha ao processar webhook do Bling');
  }
  return true;
};

// Esvazia a fila em lotes, em ordem de chegada. Antes era 1 evento a cada 2 s, o que
// atrasava preço e estoque por vários minutos após alterações em massa no Bling.
const WEBHOOK_BATCH_SIZE = 50;
let draining = false;
const drainEvents = async (app: FastifyInstance) => {
  if (draining) return;
  draining = true;
  try {
    for (let processed = 0; processed < WEBHOOK_BATCH_SIZE; processed += 1) {
      if (!await processNextEvent(app)) break;
    }
  } finally {
    draining = false;
  }
};

export const registerBlingWebhooks = (app: FastifyInstance) => {
  app.post('/webhooks/bling', async (req, reply) => {
    if (!pool) return reply.code(503).send({ accepted: false, error: 'Banco indisponível' });
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const signatureHeader = req.headers['x-bling-signature-256'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!rawBody || !verifySignature(rawBody, signature)) {
      return reply.code(401).send({ accepted: false, error: 'Assinatura inválida' });
    }
    const payload = req.body as BlingWebhook;
    if (!payload?.eventId || !payload.event || !payload.companyId || !payload.data) {
      return reply.code(400).send({ accepted: false, error: 'Evento inválido' });
    }
    const expectedCompanyId = process.env.BLING_COMPANY_ID;
    if (expectedCompanyId && payload.companyId !== expectedCompanyId) {
      return reply.code(403).send({ accepted: false, error: 'Empresa não autorizada' });
    }
    const inserted = await pool.query(
      `insert into bling_webhook_events
        (event_id, event_name, company_id, event_date, payload, status)
       values ($1,$2,$3,$4,$5::jsonb,'PENDING')
       on conflict (event_id) do nothing returning event_id`,
      [payload.eventId, payload.event, payload.companyId, payload.date ? new Date(payload.date) : new Date(), JSON.stringify(payload)]
    ) as { rowCount: number | null };
    reply.code(inserted.rowCount ? 202 : 200);
    return { accepted: true, idempotent: !inserted.rowCount };
  });
  const timer = setInterval(() => {
    void drainEvents(app).catch(error => app.log.error({ error }, 'Falha no worker de webhooks do Bling'));
  }, 2_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
};

export const getWebhookHealth = async () => {
  if (!pool) return { pending: 0, failed: 0, dead: 0 };
  const result = await pool.query(
    `select status, count(*)::int as count from bling_webhook_events
     where status in ('PENDING','PROCESSING','FAILED','DEAD') group by status`
  ) as { rows: { status: string; count: number }[] };
  const counts = Object.fromEntries(result.rows.map(row => [row.status.toLowerCase(), row.count]));
  return {
    pending: (counts.pending ?? 0) + (counts.processing ?? 0),
    failed: counts.failed ?? 0,
    dead: counts.dead ?? 0
  };
};
