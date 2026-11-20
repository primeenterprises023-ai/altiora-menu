import { describe, expect, test } from 'bun:test';
import { ApiError } from '../lib/api';
import { bpsToPercentText, fieldErrors, listPt, nextOrder, nextTableNumber, parsePercentToBps, parseTableNumber, plain, reorderUpdates } from './forms';

describe('parsePercentToBps (taxa de serviço)', () => {
  test('aceita as formas normais de escrever uma percentagem', () => {
    expect(parsePercentToBps('0')).toBe(0);
    expect(parsePercentToBps('10')).toBe(1000);
    expect(parsePercentToBps('12,5')).toBe(1250);
    expect(parsePercentToBps('12.5')).toBe(1250);
    expect(parsePercentToBps('7.5 %')).toBe(750);
    expect(parsePercentToBps(' 10 ')).toBe(1000);
    expect(parsePercentToBps('0,25')).toBe(25);
    expect(parsePercentToBps('30')).toBe(3000);
  });

  test('recusa o que não é uma percentagem de 0 a 30 com no máximo duas casas', () => {
    for (const bad of ['', ' ', 'abc', '-1', '31', '30,01', '100', '12,345', '1e1', '10%%', '1 0', '+5', '0x10', ',5', '5,', '--']) {
      expect(parsePercentToBps(bad)).toBeNull();
    }
  });

  test('não há erros de arredondamento nas casas decimais', () => {
    for (let n = 0; n <= 3000; n++) {
      const text = bpsToPercentText(n);
      expect(parsePercentToBps(text)).toBe(n);
    }
  });
});

describe('bpsToPercentText', () => {
  test('escreve com vírgula e sem zeros a mais', () => {
    expect(bpsToPercentText(1000)).toBe('10');
    expect(bpsToPercentText(1250)).toBe('12,5');
    expect(bpsToPercentText(25)).toBe('0,25');
    expect(bpsToPercentText(0)).toBe('0');
  });
});

describe('parseTableNumber / nextTableNumber', () => {
  test('só aceita inteiros de 1 a 9999', () => {
    expect(parseTableNumber('1')).toBe(1);
    expect(parseTableNumber(' 12 ')).toBe(12);
    expect(parseTableNumber('9999')).toBe(9999);
    for (const bad of ['', '0', '10000', '-3', '1.5', 'a', '1a', '０１']) expect(parseTableNumber(bad)).toBeNull();
  });
  test('o número seguinte é o maior mais um', () => {
    expect(nextTableNumber([])).toBe(1);
    expect(nextTableNumber([{ table_number: 3 }, { table_number: 7 }, { table_number: 5 }])).toBe(8);
    expect(nextTableNumber([{ table_number: 9999 }])).toBe(9999);
  });
});

describe('listPt', () => {
  test('junta com vírgulas e "e"', () => {
    expect(listPt([])).toBe('');
    expect(listPt([1])).toBe('1');
    expect(listPt([1, 2])).toBe('1 e 2');
    expect(listPt([1, 2, 3])).toBe('1, 2 e 3');
  });
});

describe('plain', () => {
  test('ignora acentos e maiúsculas', () => {
    expect(plain('Feijão')).toBe('feijao');
    expect(plain('TRÊS')).toBe('tres');
    expect(plain('Água mineral')).toBe('agua mineral');
  });
});

describe('fieldErrors', () => {
  test('lê os erros por campo da API e fica com o primeiro de cada campo', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'Dados inválidos.', [
      { field: 'name', message: 'Nome curto.' },
      { field: 'name', message: 'Outra.' },
      { field: 'manager.email', message: 'E-mail inválido.' },
      { field: 5, message: 'ignorado' },
      null,
    ]);
    expect(fieldErrors(err)).toEqual({ name: 'Nome curto.', 'manager.email': 'E-mail inválido.' });
  });
  test('devolve vazio para erros sem detalhes ou que não são da API', () => {
    expect(fieldErrors(new Error('x'))).toEqual({});
    expect(fieldErrors(new ApiError(500, 'INTERNAL', 'Erro.'))).toEqual({});
    expect(fieldErrors(null)).toEqual({});
  });
});

describe('reorderUpdates / nextOrder', () => {
  const list = [
    { id: 'a', display_order: 10 },
    { id: 'b', display_order: 20 },
    { id: 'c', display_order: 30 },
  ];
  test('troca dois vizinhos e só devolve o que muda', () => {
    expect(reorderUpdates(list, 1, -1)).toEqual([
      { id: 'b', display_order: 10 },
      { id: 'a', display_order: 20 },
    ]);
  });
  test('nos limites da lista não faz nada', () => {
    expect(reorderUpdates(list, 0, -1)).toEqual([]);
    expect(reorderUpdates(list, 2, 1)).toEqual([]);
  });
  test('o próximo número fica depois do maior', () => {
    expect(nextOrder([])).toBe(10);
    expect(nextOrder(list)).toBe(40);
  });
});
