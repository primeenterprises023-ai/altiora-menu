import { useEffect, useLayoutEffect, useState } from 'react';
import { ALLERGENS } from '../../../../shared/allergens';
import { parseKzToCents } from '../../../../shared/money';
import type { StaffMenu, StaffMenuItem } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { kz } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { SelectField, Switch, TextArea, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { menu as menuApi } from '../data';
import { fieldErrors, nextOrder } from '../forms';
import { ConfirmSheet } from '../orders/ConfirmSheet';
import { centsToInput } from '../orders/PaymentSheet';
import { useFeatures } from '../features';
import { ImageField, ModelField } from './FileFields';
import { OptionSheet, type OptionState } from './OptionSheet';

interface Props {
  /** null = fechada; itemId null = prato novo. */
  state: { itemId: string | null; categoryId?: string } | null;
  menu: StaffMenu | undefined;
  onClose: () => void;
  /** Guardou (ou criou) o prato: a página atualiza a lista já, sem esperar. */
  onSaved: (item: StaffMenuItem, created: boolean) => void;
  onChanged: () => void;
}

export function ItemSheet({ state, menu, onClose, onSaved, onChanged }: Props) {
  const toast = useToast();
  const item = state?.itemId ? menu?.categories.flatMap((c) => c.items).find((i) => i.id === state.itemId) : undefined;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [price, setPrice] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [thumbUrl, setThumbUrl] = useState('');
  const [modelUrl, setModelUrl] = useState('');
  const [ingredientsText, setIngredientsText] = useState('');
  const [allergens, setAllergens] = useState<string[]>([]);
  const [available, setAvailable] = useState(true);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [option, setOption] = useState<OptionState | null>(null);
  const features = useFeatures();

  const key = state ? (state.itemId ?? `novo:${state.categoryId ?? ''}`) : null;
  useLayoutEffect(() => {
    if (key === null) return;
    setName(item?.name ?? '');
    setDescription(item?.description ?? '');
    setCategoryId(item?.category_id ?? state?.categoryId ?? menu?.categories[0]?.id ?? '');
    setPrice(item ? centsToInput(item.price_cents) : '');
    setImageUrl(item?.image_url ?? '');
    setThumbUrl(item?.thumb_url ?? '');
    setModelUrl(item?.model_url ?? '');
    setIngredientsText((item?.ingredients ?? []).join(', '));
    setAllergens(item?.allergens ?? []);
    setAvailable(item?.available ?? true);
    setActive(item?.active ?? true);
    setBusy(false);
    setError(null);
    setErrors({});
    // só ao abrir (ou ao passar de "novo" para o prato criado)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // o prato desapareceu (apagado noutro aparelho)
  useEffect(() => {
    if (state?.itemId && menu && !item) onClose();
  }, [state?.itemId, menu, item, onClose]);

  if (!state) return null;
  const categories = menu?.categories ?? [];
  const ingredients = parseIngredients(ingredientsText);

  const save = async () => {
    if (busy) return;
    const cents = parseKzToCents(price);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Indique o nome do prato.';
    if (cents === null) next.price_cents = 'Indique um preço válido (ex.: 8500 ou 8500,50).';
    if (!categoryId) next.category_id = 'Escolha a categoria.';
    if (ingredients.some((i) => i.length > 60)) next.ingredients = 'Cada ingrediente pode ter no máximo 60 letras.';
    if (ingredients.length > 30) next.ingredients = 'No máximo 30 ingredientes.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    const body = {
      category_id: categoryId,
      name: name.trim(),
      description: description.trim() || null,
      image_url: imageUrl || null,
      thumb_url: imageUrl ? thumbUrl || null : null,
      ...(features.has('model_3d') ? { model_url: modelUrl || null } : {}),
      ingredients,
      allergens,
      price_cents: cents!,
      available,
      active,
    };
    try {
      if (item) {
        const r = await menuApi.updateItem(item.id, body);
        onSaved({ ...r.item, options: item.options }, false);
        toast.show('Prato guardado.');
        onClose();
      } else {
        const siblings = categories.find((c) => c.id === categoryId)?.items ?? [];
        const r = await menuApi.createItem({ ...body, display_order: nextOrder(siblings) });
        onSaved(r.item, true);
        toast.show('Prato criado. Pode agora juntar tamanhos e extras, se quiser.');
        setBusy(false);
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!item) return;
    await menuApi.deleteItem(item.id);
    toast.show('Prato apagado.');
    setDeleting(false);
    onChanged();
    onClose();
  };

  return (
    <>
      <Sheet
        open
        wide
        onClose={onClose}
        locked={busy}
        title={item ? 'Editar prato' : 'Novo prato'}
        footer={
          <div className="stack-sm">
            <Button size="big" block loading={busy} onClick={() => void save()}>
              {item ? 'Guardar' : 'Criar prato'}
            </Button>
            {item ? (
              <Button variant="danger-quiet" block disabled={busy} onClick={() => setDeleting(true)}>
                Apagar prato
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="stack">
          {error ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}
          <TextField label="Nome do prato" value={name} maxLength={120} error={errors.name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Muamba de galinha" autoComplete="off" />
          <TextArea label="Descrição (opcional)" rows={3} maxLength={600} value={description} error={errors.description} onChange={(e) => setDescription(e.target.value)} hint="O que leva, como vem servido." />
          <div className="field-row">
            <SelectField label="Categoria" value={categoryId} error={errors.category_id} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            <TextField label="Preço (Kz)" value={price} inputMode="decimal" error={errors.price_cents} onChange={(e) => setPrice(e.target.value)} placeholder="8500" autoComplete="off" />
          </div>
          <ImageField
            label="Fotografia (opcional)"
            preset="photo"
            value={imageUrl}
            onChange={setImageUrl}
            onThumb={setThumbUrl}
            disabled={busy}
            hint="Escolha uma fotografia do prato. É reduzida automaticamente para abrir depressa no telemóvel dos clientes."
          />
          {errors.image_url ? <p className="field-error">{errors.image_url}</p> : null}
          <TextArea
            label="Ingredientes (opcional)"
            rows={2}
            maxLength={900}
            value={ingredientsText}
            error={errors.ingredients}
            onChange={(e) => setIngredientsText(e.target.value)}
            hint="Separe por vírgulas. Ex.: galinha, óleo de palma, quiabo, alho."
          />
          <fieldset className="allergens">
            <legend className="label">Alergénios que o prato contém</legend>
            <div className="allergen-grid">
              {ALLERGENS.map((a) => (
                <label key={a.code} className="check-row">
                  <input
                    type="checkbox"
                    checked={allergens.includes(a.code)}
                    onChange={(e) => setAllergens((cur) => (e.target.checked ? [...cur, a.code] : cur.filter((c) => c !== a.code)))}
                  />
                  <span className="check-label">{a.label}</span>
                </label>
              ))}
            </div>
            <p className="hint">Marque tudo o que o prato leva. É uma ajuda ao cliente; em caso de dúvida, o cliente deve perguntar à equipa.</p>
          </fieldset>
          <ModelField value={modelUrl} allowed={features.has('model_3d')} dishName={name} poster={imageUrl || undefined} onChange={setModelUrl} disabled={busy} />

          <div className="stack-sm">
            <Switch checked={available} onChange={setAvailable} label="Disponível agora" />
            <Switch checked={active} onChange={setActive} label="Mostrar no menu" />
            {!available ? <p className="muted small">Aparece no menu como "Esgotado" e não pode ser pedido.</p> : null}
            {!active ? <p className="muted small">Escondido: os clientes não o veem.</p> : null}
          </div>

          {item ? (
            <>
              <OptionList kind="size" item={item} onOpen={setOption} />
              <OptionList kind="extra" item={item} onOpen={setOption} />
            </>
          ) : (
            <p className="muted small">Depois de criar o prato, pode juntar-lhe tamanhos e extras.</p>
          )}
        </div>
      </Sheet>
      <OptionSheet state={option} item={item} onClose={() => setOption(null)} onChanged={onChanged} />
      <ConfirmSheet open={deleting} danger title="Apagar prato" confirmLabel="Apagar prato" onClose={() => setDeleting(false)} onConfirm={remove}>
        <p>
          Vai apagar <strong>{item?.name}</strong> do menu. Os pedidos já feitos continuam no histórico com o nome e o preço de quando foram feitos.
        </p>
        <p className="muted">Se só quer que deixe de aparecer, é melhor desligar "Mostrar no menu".</p>
      </ConfirmSheet>
    </>
  );
}


/** "galinha, óleo de palma ,quiabo" → ["galinha", "óleo de palma", "quiabo"] (sem repetidos). */
export function parseIngredients(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n;]/)) {
    const t = part.trim().replace(/\s+/g, ' ');
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function OptionList({ kind, item, onOpen }: { kind: 'size' | 'extra'; item: StaffMenuItem; onOpen: (s: OptionState) => void }) {
  const list = item.options.filter((o) => o.kind === kind);
  const size = kind === 'size';
  return (
    <section className="stack-sm" aria-label={size ? 'Tamanhos do prato' : 'Extras do prato'}>
      <div className="split-head">
        <h3 className="section-title">{size ? 'Tamanhos' : 'Extras'}</h3>
        <Button size="sm" variant="secondary" onClick={() => onOpen({ itemId: item.id, optionId: null, kind })}>
          {size ? 'Adicionar tamanho' : 'Adicionar extra'}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="muted small">
          {size ? 'Sem tamanhos. O cliente escolhe um (ex.: "Meia dose" e "Dose inteira") e o preço do tamanho soma-se ao preço do prato.' : 'Sem extras. Um extra é algo que o cliente pode juntar ao prato (ex.: "Funge extra").'}
        </p>
      ) : (
        <ul className="extras-list">
          {list.map((o) => (
            <li key={o.id}>
              <button type="button" className="extra-row" onClick={() => onOpen({ itemId: item.id, optionId: o.id, kind })}>
                <span className="extra-name">{o.name}</span>
                <span className="extra-side muted">
                  {o.price_delta_cents > 0 ? `+ ${kz(o.price_delta_cents)}` : size ? 'Incluído' : 'Grátis'}
                  {!o.active ? <Badge>Escondido</Badge> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
