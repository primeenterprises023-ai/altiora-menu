import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_STATUSES,
  CUSTOMER_STATUS_LABEL,
  ORDER_STATUSES,
  STATUS_LABEL,
  canTransition,
  isOrderStatus,
  nextAction,
  transitionNeedsReason,
  type OrderStatus,
  type TransitionRole,
} from './status';

type Pair = `${OrderStatus}>${OrderStatus}`;
const forward: Pair[] = ['novo>em_preparacao', 'em_preparacao>pronto', 'pronto>entregue'];
const cancels: Pair[] = ['novo>cancelado', 'em_preparacao>cancelado', 'pronto>cancelado'];
const corrections: Pair[] = ['em_preparacao>novo', 'pronto>em_preparacao', 'entregue>pronto', 'cancelado>novo'];

// Tabela de permissões escrita à mão (a fonte de verdade das regras de negócio).
const EXPECTED: Record<Exclude<TransitionRole, 'system'>, Set<Pair>> = {
  kitchen: new Set<Pair>(['novo>em_preparacao', 'em_preparacao>pronto']),
  waiter: new Set<Pair>(['pronto>entregue']),
  manager: new Set<Pair>([...forward, ...cancels, ...corrections]),
};

describe('transições de estado', () => {
  test('cada perfil só pode fazer exatamente o que lhe cabe (todas as 100 combinações)', () => {
    for (const role of ['kitchen', 'waiter', 'manager'] as const) {
      for (const from of ORDER_STATUSES) {
        for (const to of ORDER_STATUSES) {
          const expected = EXPECTED[role].has(`${from}>${to}`);
          expect({ role, from, to, allowed: canTransition(role, from, to) }).toEqual({ role, from, to, allowed: expected });
        }
      }
    }
  });

  test('o sistema pode tudo, exceto manter o mesmo estado; ninguém "transita" para o próprio estado', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition('system', from, to)).toBe(from !== to);
        for (const role of ['kitchen', 'waiter', 'manager'] as const) if (from === to) expect(canTransition(role, from, to)).toBe(false);
      }
    }
  });

  test('a cozinha e o empregado nunca cancelam, nunca corrigem e nunca mexem em pedidos entregues ou cancelados', () => {
    for (const role of ['kitchen', 'waiter'] as const) {
      for (const from of ORDER_STATUSES) {
        expect(canTransition(role, from, 'cancelado')).toBe(false);
        if (from === 'entregue' || from === 'cancelado') for (const to of ORDER_STATUSES) expect(canTransition(role, from, to)).toBe(false);
      }
    }
    expect(canTransition('kitchen', 'pronto', 'entregue')).toBe(false); // entregar é com o empregado
    expect(canTransition('waiter', 'novo', 'em_preparacao')).toBe(false); // cozinhar é com a cozinha
  });

  test('cancelamentos e correções exigem motivo; avançar normalmente não', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const key = `${from}>${to}` as Pair;
        const needs = to === 'cancelado' || corrections.includes(key);
        expect({ from, to, needs: transitionNeedsReason(from, to) }).toEqual({ from, to, needs });
      }
    }
    for (const k of forward) {
      const [f, t] = k.split('>') as [OrderStatus, OrderStatus];
      expect(transitionNeedsReason(f, t)).toBe(false);
    }
  });
});

describe('próxima ação dos botões grandes', () => {
  test('cozinha avança novo → em preparação → pronto; empregado entrega; sem ação quando não há nada a fazer', () => {
    expect(nextAction('kitchen', 'novo')).toEqual({ to: 'em_preparacao', label: 'Iniciar preparação' });
    expect(nextAction('kitchen', 'em_preparacao')).toEqual({ to: 'pronto', label: 'Marcar como pronto' });
    expect(nextAction('kitchen', 'pronto')).toBeNull();
    expect(nextAction('waiter', 'pronto')).toEqual({ to: 'entregue', label: 'Confirmar entrega' });
    expect(nextAction('waiter', 'novo')).toBeNull();
    expect(nextAction('waiter', 'em_preparacao')).toBeNull();
    for (const role of ['kitchen', 'waiter', 'manager'] as const) {
      expect(nextAction(role, 'entregue')).toBeNull();
      expect(nextAction(role, 'cancelado')).toBeNull();
    }
  });

  test('a ação sugerida é sempre uma transição permitida a esse perfil, sem pedir motivo', () => {
    for (const role of ['kitchen', 'waiter', 'manager'] as const) {
      for (const from of ORDER_STATUSES) {
        const a = nextAction(role, from);
        if (!a) continue;
        expect(canTransition(role, from, a.to)).toBe(true);
        expect(transitionNeedsReason(from, a.to)).toBe(false);
      }
    }
  });
});

describe('textos e utilitários', () => {
  test('todos os estados têm texto para a equipa e para o cliente', () => {
    for (const s of ORDER_STATUSES) {
      expect(STATUS_LABEL[s].length).toBeGreaterThan(2);
      expect(CUSTOMER_STATUS_LABEL[s].length).toBeGreaterThan(2);
    }
    expect(CUSTOMER_STATUS_LABEL.novo).toBe('Pedido recebido');
  });

  test('isOrderStatus e estados em curso', () => {
    for (const s of ORDER_STATUSES) expect(isOrderStatus(s)).toBe(true);
    for (const v of ['', 'NOVO', 'pago', null, undefined, 3, {}, ['novo']]) expect(isOrderStatus(v)).toBe(false);
    expect([...ACTIVE_STATUSES]).toEqual(['novo', 'em_preparacao', 'pronto']);
  });
});
