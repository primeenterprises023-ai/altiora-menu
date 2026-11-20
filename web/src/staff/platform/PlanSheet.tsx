// Criar ou editar um plano comercial: nome, frase, funcionalidades incluídas e preços por moeda (definidos pela Altiora).
// Não há pagamentos no sistema: os preços servem para mostrar a tabela de planos na página comercial.
import { useLayoutEffect, useState } from 'react';
import { CURRENCIES, FEATURE_KEYS, FEATURES, type Currency, type FeatureKey } from '../../../../shared/plans';
import { currencySymbol, parseKzToCents } from '../../../../shared/money';
import type { AdminPlan } from '../../../../shared/types';
import { ApiError, errorText } from '../../lib/api';
import { Button } from '../../ui/Button';
import { SelectField, Switch, TextArea, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { admin } from '../data';
import { fieldErrors } from '../forms';

const CODE_RE = /^[a-z][a-z0-9_]{1,30}$/;

interface PriceRow {
  currency: Currency;
  monthly: string;
  yearly: string;
}

/** Cêntimos → texto editável ("25000" ou "25000,50"), sem separador de milhares. */
export function moneyText(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac ? `${whole},${String(frac).padStart(2, '0')}` : String(whole);
}

/** Dependências entre funcionalidades: a realidade aumentada usa o modelo 3D; sem o cardápio nada funciona. */
export function normalizeFeatures(list: Iterable<FeatureKey>): FeatureKey[] {
  const set = new Set<FeatureKey>(list);
  set.add('menu');
  if (set.has('ar')) set.add('model_3d');
  return FEATURE_KEYS.filter((k) => set.has(k));
}

interface Props {
  /** null + create = novo plano; um plano = editar; null sem create = fechado. */
  plan: AdminPlan | null;
  create: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function PlanSheet({ plan, create, onClose, onSaved }: Props) {
  const toast = useToast();
  const open = create || !!plan;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [order, setOrder] = useState('1');
  const [highlighted, setHighlighted] = useState(false);
  const [active, setActive] = useState(true);
  const [features, setFeatures] = useState<FeatureKey[]>(['menu']);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const key = create ? 'novo' : (plan?.code ?? '');
  useLayoutEffect(() => {
    if (!open) return;
    setCode(plan?.code ?? '');
    setName(plan?.name ?? '');
    setTagline(plan?.tagline ?? '');
    setOrder(String(plan?.display_order ?? 1));
    setHighlighted(plan?.highlighted ?? false);
    setActive(plan?.active ?? true);
    setFeatures(plan ? normalizeFeatures(plan.features) : ['menu']);
    setPrices(
      plan
        ? plan.prices.map((p) => ({ currency: p.currency as Currency, monthly: moneyText(p.monthly_cents), yearly: p.yearly_cents === null ? '' : moneyText(p.yearly_cents) }))
        : [{ currency: 'AOA', monthly: '', yearly: '' }],
    );
    setBusy(false);
    setError(null);
    setErrors({});
    // só ao abrir (ou ao mudar de plano): as atualizações da lista não devem apagar o que está a ser editado
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  if (!open) return null;
  const clear = (k: string) => setErrors((cur) => ({ ...cur, [k]: '' }));

  const toggle = (f: FeatureKey, on: boolean) => {
    const next = new Set(features);
    if (on) next.add(f);
    else {
      next.delete(f);
      if (f === 'model_3d') next.delete('ar'); // sem o modelo 3D não há realidade aumentada
    }
    setFeatures(normalizeFeatures(next));
  };

  const usedCurrencies = new Set(prices.map((p) => p.currency));
  const freeCurrencies = CURRENCIES.filter((c) => !usedCurrencies.has(c));

  const setPrice = (i: number, patch: Partial<PriceRow>) => {
    setPrices((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    clear('prices');
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    const problems: Record<string, string> = {};
    const c = code.trim().toLowerCase();
    const n = name.trim();
    const ord = Number(order);
    if (create && !CODE_RE.test(c)) problems.code = 'Use letras minúsculas, números e _ (ex.: gold), começando por uma letra.';
    if (n.length < 2) problems.name = 'Escreva o nome do plano (pelo menos 2 letras).';
    if (tagline.trim().length > 160) problems.tagline = 'A frase não pode ter mais de 160 letras.';
    if (!Number.isInteger(ord) || ord < 0 || ord > 1000) problems.order = 'Escreva um número inteiro entre 0 e 1000.';
    const outPrices: Array<{ currency: Currency; monthly_cents: number; yearly_cents: number | null }> = [];
    for (const row of prices) {
      const monthlyText = row.monthly.trim();
      const yearlyText = row.yearly.trim();
      if (!monthlyText && !yearlyText) continue; // linha vazia: ignora
      const monthly = monthlyText ? parseKzToCents(monthlyText) : null;
      const yearly = yearlyText ? parseKzToCents(yearlyText) : null;
      if (monthly === null) problems.prices = `Preço mensal em ${row.currency}: escreva um valor, por exemplo 25000 ou 25 000,50.`;
      else if (yearlyText && yearly === null) problems.prices = `Preço anual em ${row.currency}: escreva um valor válido ou deixe vazio.`;
      else outPrices.push({ currency: row.currency, monthly_cents: monthly, yearly_cents: yearly });
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;

    const body = { name: n, tagline: tagline.trim(), display_order: ord, highlighted, active, features: normalizeFeatures(features), prices: outPrices };
    setBusy(true);
    try {
      if (create) await admin.createPlan({ code: c, ...body });
      else await admin.updatePlan(plan!.code, body);
      toast.show(create ? 'Plano criado.' : 'Plano guardado. Os restaurantes que o usam já têm as alterações.');
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PLAN_EXISTS') setErrors({ code: 'Já existe um plano com este código.' });
      else {
        const raw = fieldErrors(err);
        if (raw.code || raw.name || raw.tagline || raw.prices) setErrors({ code: raw.code ?? '', name: raw.name ?? '', tagline: raw.tagline ?? '', prices: raw.prices ?? '' });
        else setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      wide
      title={create ? 'Novo plano' : `Plano ${plan!.name}`}
      footer={
        <Button size="big" block loading={busy} onClick={() => void submit()}>
          {create ? 'Criar plano' : 'Guardar plano'}
        </Button>
      }
    >
      <form
        className="stack-lg"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error ? (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        ) : null}
        {!create && plan && plan.restaurants > 0 ? (
          <p className="notice notice-info">
            {plan.restaurants === 1 ? '1 restaurante usa' : `${plan.restaurants} restaurantes usam`} este plano. As alterações às funcionalidades aplicam-se de imediato.
          </p>
        ) : null}

        <div className="stack">
          {create ? (
            <TextField
              label="Código do plano"
              value={code}
              maxLength={31}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              hint="Identifica o plano no sistema e não se pode mudar depois. Por exemplo: gold."
              error={errors.code}
              onChange={(e) => {
                setCode(e.target.value);
                clear('code');
              }}
            />
          ) : null}
          <TextField
            label="Nome"
            value={name}
            maxLength={40}
            autoComplete="off"
            error={errors.name}
            onChange={(e) => {
              setName(e.target.value);
              clear('name');
            }}
          />
          <TextArea
            label="Frase curta"
            value={tagline}
            rows={2}
            maxLength={160}
            hint="Aparece por baixo do nome do plano na página comercial."
            error={errors.tagline}
            onChange={(e) => {
              setTagline(e.target.value);
              clear('tagline');
            }}
          />
          <TextField
            label="Posição na lista"
            inputMode="numeric"
            value={order}
            maxLength={4}
            hint="Os planos aparecem do número mais baixo para o mais alto."
            error={errors.order}
            onChange={(e) => {
              setOrder(e.target.value);
              clear('order');
            }}
          />
          <Switch checked={highlighted} onChange={setHighlighted} label="Plano em destaque na página comercial (só um de cada vez)" />
          <Switch checked={active} onChange={setActive} label="Disponível para novos restaurantes" />
        </div>

        <fieldset className="sheet-section stack-sm feature-pick">
          <legend className="section-title">Funcionalidades incluídas</legend>
          <ul className="feature-pick-list">
            {FEATURE_KEYS.map((f) => {
              const info = FEATURES[f];
              const on = features.includes(f);
              const locked = f === 'menu';
              return (
                <li key={f}>
                  <label className="feature-pick-row">
                    <input type="checkbox" checked={on} disabled={locked || busy} onChange={(e) => toggle(f, e.target.checked)} />
                    <span>
                      <strong>{info.label}</strong>
                      <span className="muted small">{info.description}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="muted small">O cardápio digital está sempre incluído. A realidade aumentada precisa dos pratos em 3D.</p>
        </fieldset>

        <div className="sheet-section stack-sm">
          <h3 className="section-title">Preços</h3>
          <p className="muted small">Valores por mês e, se quiser, por ano, em cada moeda. Só se mostram na página comercial; o sistema não cobra nem regista pagamentos.</p>
          {prices.map((row, i) => (
            <div key={row.currency} className="price-row">
              <span className="price-cur" aria-label={`Moeda ${row.currency}`}>
                {row.currency} <span className="muted small">({currencySymbol(row.currency)})</span>
              </span>
              <TextField label="Por mês" inputMode="decimal" value={row.monthly} placeholder="25000" onChange={(e) => setPrice(i, { monthly: e.target.value })} />
              <TextField label="Por ano (opcional)" inputMode="decimal" value={row.yearly} placeholder="250000" onChange={(e) => setPrice(i, { yearly: e.target.value })} />
              <Button size="sm" variant="quiet" aria-label={`Tirar o preço em ${row.currency}`} onClick={() => setPrices((rows) => rows.filter((_, k) => k !== i))}>
                Tirar
              </Button>
            </div>
          ))}
          {errors.prices ? (
            <p className="field-error" role="alert">
              {errors.prices}
            </p>
          ) : null}
          {freeCurrencies.length > 0 ? (
            <SelectField
              label="Acrescentar preço noutra moeda"
              value=""
              onChange={(e) => {
                const c = e.target.value as Currency;
                if (c) setPrices((rows) => [...rows, { currency: c, monthly: '', yearly: '' }]);
              }}
            >
              <option value="">Escolha a moeda…</option>
              {freeCurrencies.map((c) => (
                <option key={c} value={c}>
                  {c} ({currencySymbol(c)})
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  );
}
