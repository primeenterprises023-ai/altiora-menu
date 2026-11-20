import { describe, expect, test } from 'bun:test';
import { dateText, sizeText } from './format';

describe('sizeText', () => {
  test('ficheiros pequenos em KB (nunca "0,0 MB"), grandes em MB com vírgula', () => {
    expect(sizeText(0)).toBe('1 KB');
    expect(sizeText(700)).toBe('1 KB');
    expect(sizeText(2_100)).toBe('2 KB');
    expect(sizeText(299_000)).toBe('292 KB');
    expect(sizeText(1_048_575)).toBe('1024 KB');
    expect(sizeText(1_048_576)).toBe('1,0 MB');
    expect(sizeText(12 * 1_048_576)).toBe('12,0 MB');
    expect(sizeText(80 * 1_048_576 + 524_288)).toBe('80,5 MB');
  });
});

describe('dateText', () => {
  test('AAAA-MM-DD → DD/MM/AAAA, sem fusos horários', () => {
    expect(dateText('2026-12-31')).toBe('31/12/2026');
    expect(dateText('2026-01-05T23:59:59Z')).toBe('05/01/2026');
    expect(dateText('amanhã')).toBe('amanhã');
  });
});
