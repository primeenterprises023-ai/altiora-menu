// As fotografias e os modelos 3D do restaurante de demonstração (Casa Aurora) que vão no projeto: existem, são o que dizem ser, e
// cabem num telemóvel. Se alguém os regenerar (scripts/demo-media) e algo ficar de fora, falha aqui e não na página comercial.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inspectAsset } from '../src/lib/assets';

const dir = join(import.meta.dir, '../../scripts/demo-media/assets');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { dishes: Record<string, { image: string; thumb: string; model: string | null }> };
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)));

/** Lê o bloco JSON de um GLB. */
function glbJson(file: Uint8Array): { meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>; accessors: Array<{ count: number }>; extensionsRequired?: string[]; extensionsUsed?: string[]; buffers?: Array<{ uri?: string }>; images?: unknown[] } {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + length)));
}

const dishes = Object.entries(manifest.dishes);

describe('pratos de demonstração: fotografias', () => {
  test('o manifesto lista 12 pratos, 7 com modelo 3D', () => {
    expect(dishes).toHaveLength(12);
    expect(dishes.filter(([, d]) => d.model).length).toBe(7);
  });

  for (const [id, dish] of dishes) {
    test(`${id}: fotografia 1200×900 e miniatura 480×360, ambas JPEG`, () => {
      for (const file of [dish.image, dish.thumb]) expect([file, existsSync(join(dir, file))]).toEqual([file, true]);
      expect(inspectAsset(bytes(dish.image))).toMatchObject({ kind: 'image', contentType: 'image/jpeg', width: 1200, height: 900 });
      expect(inspectAsset(bytes(dish.thumb))).toMatchObject({ kind: 'image', contentType: 'image/jpeg', width: 480, height: 360 });
      expect(statSync(join(dir, dish.thumb)).size).toBeLessThan(statSync(join(dir, dish.image)).size);
      expect(statSync(join(dir, dish.image)).size).toBeLessThan(150_000); // abre depressa em dados móveis
    });
  }
});

describe('pratos de demonstração: modelos 3D', () => {
  for (const [id, dish] of dishes.filter(([, d]) => d.model)) {
    test(`${id}: GLB válido, sem compressão, sem ficheiros externos e leve`, () => {
      const file = bytes(dish.model!);
      expect(inspectAsset(file)).toMatchObject({ kind: 'model', contentType: 'model/gltf-binary' });
      expect(file.byteLength).toBeLessThan(1_200_000);
      const doc = glbJson(file);
      expect(doc.extensionsRequired ?? []).toEqual([]); // nada de Draco, Meshopt ou KTX2
      for (const entry of [...(doc.buffers ?? []), ...((doc.images ?? []) as Array<{ uri?: string }>)]) expect(entry.uri === undefined || entry.uri.startsWith('data:')).toBe(true);
      let triangles = 0;
      for (const mesh of doc.meshes ?? []) {
        for (const primitive of mesh.primitives) {
          const count = primitive.indices !== undefined ? doc.accessors[primitive.indices]!.count : doc.accessors[primitive.attributes.POSITION!]!.count;
          triangles += count / 3;
        }
      }
      expect(triangles).toBeGreaterThan(500);
      expect(triangles).toBeLessThan(60_000); // fluido num telemóvel
    });
  }

  test('os pratos sem modelo 3D mostram só a fotografia (nada de 3D inventado)', () => {
    for (const [, dish] of dishes.filter(([, d]) => !d.model)) expect(dish.model).toBeNull();
    const glbs = readdirSync(dir).filter((name) => name.endsWith('.glb'));
    expect(glbs.sort()).toEqual(dishes.filter(([, d]) => d.model).map(([, d]) => d.model!).sort());
  });
});

describe('restaurante de demonstração: capa e logótipo', () => {
  test('capa 1600×900 (JPEG) e logótipo 512×512 (PNG)', () => {
    expect(inspectAsset(bytes('cover.jpg'))).toMatchObject({ contentType: 'image/jpeg', width: 1600, height: 900 });
    expect(inspectAsset(bytes('logo.png'))).toMatchObject({ contentType: 'image/png', width: 512, height: 512 });
  });

  test('não há ficheiros a mais na pasta (todos estão no manifesto, na capa ou no logótipo)', () => {
    const wanted = new Set(['manifest.json', 'cover.jpg', 'logo.png', ...dishes.flatMap(([, d]) => [d.image, d.thumb, ...(d.model ? [d.model] : [])])]);
    expect(readdirSync(dir).filter((name) => !wanted.has(name))).toEqual([]);
  });
});
