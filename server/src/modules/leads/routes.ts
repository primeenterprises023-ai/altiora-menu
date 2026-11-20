// Pedidos de contacto vindos da página comercial (formulário público) e o seu tratamento no painel da Altiora.
import { LeadInput } from '../../../../shared/landing';
import { LeadUpdateInput, uuid } from '../../../../shared/schemas';
import type { AdminLead } from '../../../../shared/types';
import { iso } from '../../db/client';
import { audit } from '../../lib/audit';
import { notFound, tooMany } from '../../lib/errors';
import { created, json, noContent } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

async function submit(ctx: Ctx): Promise<Response> {
  const input = await ctx.body(LeadInput);
  // robôs preenchem o campo escondido: respondemos "ok" sem guardar nada
  if (input.website !== '') return created({ ok: true });
  const hour = ctx.deps.limiter.hit(`lead-hour:${ctx.ip}`, 4, 3_600_000);
  if (!hour.ok) throw tooMany('Já enviou vários pedidos. Aguarde um pouco ou contacte-nos diretamente.', hour.retryAfterSec, 'RATE_LIMITED');
  const day = ctx.deps.limiter.hit('lead-day:all', 300, 86_400_000);
  if (!day.ok) throw tooMany('Recebemos muitos pedidos neste momento. Tente mais tarde.', day.retryAfterSec, 'RATE_LIMITED');
  await ctx.deps.db.system((tx) =>
    tx`INSERT INTO leads (name, business, phone, email, message) VALUES (${input.name}, ${input.business}, ${input.phone}, ${input.email}, ${input.message})`,
  );
  return created({ ok: true });
}

interface Row { id: string; name: string; business: string; phone: string; email: string; message: string; status: AdminLead['status']; created_at: Date }
const view = (r: Row): AdminLead => ({ ...r, created_at: iso(r.created_at)! });

async function list(ctx: Ctx): Promise<Response> {
  const rows = await ctx.deps.db.as(ctx.dbContext(), (tx) =>
    tx<Row>`SELECT id, name, business, phone, email, message, status, created_at FROM leads ORDER BY (status = 'novo') DESC, created_at DESC LIMIT 200`,
  );
  return json({ leads: rows.map(view) });
}

async function update(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pedido não encontrado.', 'LEAD_NOT_FOUND');
  const input = await ctx.body(LeadUpdateInput);
  const row = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [r] = await tx<Row>`
      UPDATE leads SET status = ${input.status}, handled_at = CASE WHEN ${input.status} = 'novo' THEN NULL ELSE now() END
      WHERE id = ${id.data} RETURNING id, name, business, phone, email, message, status, created_at`;
    if (!r) throw notFound('Pedido não encontrado.', 'LEAD_NOT_FOUND');
    await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: 'platform', action: 'platform.lead.update', entityType: 'lead', entityId: id.data, metadata: { status: input.status }, ip: ctx.ip });
    return r;
  });
  return json({ lead: view(row) });
}

async function remove(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Pedido não encontrado.', 'LEAD_NOT_FOUND');
  await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const rows = await tx`DELETE FROM leads WHERE id = ${id.data} RETURNING id`;
    if (rows.length === 0) throw notFound('Pedido não encontrado.', 'LEAD_NOT_FOUND');
    await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: 'platform', action: 'platform.lead.delete', entityType: 'lead', entityId: id.data, ip: ctx.ip });
  });
  return noContent();
}

export const leadRoutes: RouteSpec[] = [
  { method: 'POST', path: '/api/leads', access: 'public', handler: submit, limits: [{ name: 'lead-submit', max: 10, windowMs: 3_600_000 }] },
  { method: 'GET', path: '/api/admin/leads', access: 'platform', handler: list },
  { method: 'PATCH', path: '/api/admin/leads/:id', access: 'platform', handler: update },
  { method: 'DELETE', path: '/api/admin/leads/:id', access: 'platform', handler: remove },
];
