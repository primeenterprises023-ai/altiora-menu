// Envio de fotografias e modelos 3D pelo gerente. Os ficheiros ficam na base de dados e são entregues em /a/<id>.
import { createHash } from 'node:crypto';
import { AssetError, inspectAsset } from '../../lib/assets';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';
import { requireFeature } from '../../lib/plans';
import { created } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

/** Fotografias: o ecrã do gerente reduz-as antes de enviar (máx. 1600 px), por isso 2 MB é largo. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_BYTES = 12 * 1024 * 1024;

async function upload(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  const bytes = await ctx.bytes(MAX_MODEL_BYTES);
  let info;
  try {
    info = inspectAsset(bytes);
  } catch (err) {
    if (err instanceof AssetError) throw new HttpError(422, 'ASSET_INVALID', err.message);
    throw err;
  }
  if (info.kind === 'image' && bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'A fotografia é demasiado grande (máximo 2 MB). Escolha uma mais pequena.');
  }
  if (info.kind === 'model') await requireFeature(ctx.deps.db, rid, 'model_3d', 'pratos em 3D');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const quota = ctx.deps.config.assetQuotaBytes;
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: rid, userId: a.userId }, async (tx) => {
    // um envio de cada vez por restaurante: a verificação do espaço e a gravação não se podem cruzar
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'assets:' + rid}))`;
    const [used] = await tx<{ n: string }>`SELECT coalesce(sum(byte_size), 0)::text AS n FROM assets WHERE restaurant_id = ${rid}`;
    if (Number(used?.n ?? 0) + bytes.byteLength > quota) {
      throw new HttpError(413, 'STORAGE_FULL', `O espaço de ficheiros do restaurante está cheio (${Math.round(quota / 1048576)} MB). Apague pratos ou fotografias que já não usa.`);
    }
    const [r] = await tx<{ id: string }>`
      INSERT INTO assets (restaurant_id, kind, content_type, byte_size, sha256, width, height, data, created_by)
      VALUES (${rid}, ${info.kind}, ${info.contentType}, ${bytes.byteLength}, ${sha256}, ${info.width}, ${info.height}, ${bytes}, ${a.userId})
      RETURNING id`;
    await audit(tx, { restaurantId: rid, actorId: a.userId, actorRole: a.role, action: 'asset.upload', entityType: 'asset', entityId: r!.id, metadata: { kind: info.kind, bytes: bytes.byteLength }, ip: ctx.ip });
    return r!;
  });
  return created({ asset: { id: row.id, url: `/a/${row.id}`, kind: info.kind, content_type: info.contentType, byte_size: bytes.byteLength, width: info.width, height: info.height } });
}

export const assetRoutes: RouteSpec[] = [
  { method: 'POST', path: '/api/assets', access: { roles: ['manager'] }, handler: upload, noBody: true, limits: [{ name: 'asset-upload', max: 60, windowMs: 60_000 }] },
];
