// «Chamar o garçom»: o empregado (e o gerente) vê as mesas que chamaram e marca cada chamada como atendida.
import type { WaiterCallView } from '../../../../shared/types';
import { uuid } from '../../../../shared/schemas';
import { iso } from '../../db/client';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

interface Row { id: string; table_id: string; table_number: number; table_label: string | null; status: WaiterCallView['status']; created_at: Date; resolved_at: Date | null }
const view = (r: Row): WaiterCallView => ({ ...r, created_at: iso(r.created_at)!, resolved_at: iso(r.resolved_at) });

async function list(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rows = await ctx.deps.db.as(ctx.dbContext(), (tx) =>
    tx<Row>`SELECT id, table_id, table_number, table_label, status, created_at, resolved_at FROM waiter_calls
            WHERE restaurant_id = ${a.restaurantId!} AND status = 'aberta' ORDER BY created_at`,
  );
  return json({ server_time: new Date().toISOString(), calls: rows.map(view) });
}

async function attend(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success) throw notFound('Chamada não encontrada.', 'CALL_NOT_FOUND');
  const out = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [r] = await tx<Row>`
      UPDATE waiter_calls SET status = 'atendida', resolved_at = now(), resolved_by = ${a.userId}
      WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId!} AND status = 'aberta'
      RETURNING id, table_id, table_number, table_label, status, created_at, resolved_at`;
    if (!r) {
      const [exists] = await tx`SELECT 1 FROM waiter_calls WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId!}`;
      if (!exists) throw notFound('Chamada não encontrada.', 'CALL_NOT_FOUND');
      throw new HttpError(409, 'CALL_ALREADY_DONE', 'Esta chamada já foi atendida ou cancelada.');
    }
    await audit(tx, { restaurantId: a.restaurantId!, actorId: a.userId, actorRole: a.role, action: 'waiter_call.attend', entityType: 'waiter_call', entityId: r.id, metadata: { table_number: r.table_number }, ip: ctx.ip });
    return r;
  });
  ctx.deps.hub.publishRestaurant(a.restaurantId!, { type: 'waiter.call.done', call_id: out.id, at: new Date().toISOString() });
  return json({ call: view(out) });
}

export const callRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/staff/waiter-calls', access: { roles: ['waiter', 'manager'] }, handler: list },
  { method: 'POST', path: '/api/staff/waiter-calls/:id/attend', access: { roles: ['waiter', 'manager'] }, handler: attend, noBody: true },
];
