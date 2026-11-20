import { describe, expect, test } from 'bun:test';
import { planImage } from './image';

describe('planImage: tamanho final e recorte', () => {
  test('uma fotografia grande é reduzida ao maior lado, sem deformar', () => {
    expect(planImage(4000, 3000, { maxEdge: 1600 })).toMatchObject({ w: 1600, h: 1200, sx: 0, sy: 0, sw: 4000, sh: 3000 });
    expect(planImage(3000, 4000, { maxEdge: 1600 })).toMatchObject({ w: 1200, h: 1600 });
  });

  test('uma imagem pequena nunca é ampliada', () => {
    expect(planImage(300, 200, { maxEdge: 1600 })).toMatchObject({ w: 300, h: 200 });
  });

  test('a miniatura 4:3 recorta ao centro (imagem larga e imagem alta)', () => {
    const wide = planImage(4000, 1000, { maxEdge: 480, ratio: 4 / 3 });
    expect(wide).toMatchObject({ sw: 1333, sh: 1000, sx: 1334, sy: 0, w: 480, h: 360 });
    const tall = planImage(1000, 4000, { maxEdge: 480, ratio: 4 / 3 });
    expect(tall).toMatchObject({ sw: 1000, sh: 750, sx: 0, sy: 1625 });
    expect(Math.abs(tall.w / tall.h - 4 / 3)).toBeLessThan(0.01);
  });

  test('imagem já na proporção pedida: sem recorte', () => {
    expect(planImage(1600, 900, { maxEdge: 1600, ratio: 16 / 9 })).toMatchObject({ sx: 0, sy: 0, sw: 1600, sh: 900, w: 1600, h: 900 });
  });

  test('nunca devolve dimensões nulas', () => {
    const p = planImage(1, 1, { maxEdge: 1 });
    expect(p.w).toBe(1);
    expect(p.h).toBe(1);
  });
});
