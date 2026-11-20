// Detalhe de um prato: fotografia ou modelo 3D, descrição, ingredientes, alergénios, tamanho, extras, nota e quantidade.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { allergenLabel } from '../../../shared/allergens';
import type { MenuItem } from '../../../shared/types';
import { kz } from '../lib/format';
import { Button } from '../ui/Button';
import { Stepper, TextArea } from '../ui/Fields';
import { Money } from '../ui/Money';
import { Sheet } from '../ui/Sheet';
import { detectAr, sceneViewerUrl, type ArMode } from '../viewer/ar';
import { ViewerPanel } from '../viewer/ViewerPanel';
import { MAX_LINE_QUANTITY, type CartLine } from './cart';
import { CubeIcon } from './icons';

interface Props {
  item: MenuItem | null;
  /** Linha do carrinho que se está a alterar (se for o caso). */
  initial?: CartLine | null;
  /** O menu tem carrinho (pedido pelo sistema, por WhatsApp ou demonstração). */
  canAdd: boolean;
  model3d: boolean;
  ar: boolean;
  restaurantName: string;
  onClose: () => void;
  onSubmit: (line: Omit<CartLine, 'key'>, replacingKey: string | null) => void;
}

export function DishSheet({ item, initial, canAdd, model3d, ar, restaurantName, onClose, onSubmit }: Props) {
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [extras, setExtras] = useState<Set<string>>(new Set());
  const [size, setSize] = useState<string | null>(null);
  const [view3d, setView3d] = useState(false);
  const [arMode, setArMode] = useState<ArMode>(null);

  const sizes = useMemo(() => item?.options.filter((o) => o.kind === 'size') ?? [], [item]);
  const extraOptions = useMemo(() => item?.options.filter((o) => o.kind !== 'size') ?? [], [item]);

  useLayoutEffect(() => {
    if (!item) return;
    setQuantity(initial?.quantity ?? 1);
    setNotes(initial?.notes ?? '');
    const chosen = new Set(initial?.options.map((o) => o.id) ?? []);
    setExtras(new Set(extraOptions.filter((o) => chosen.has(o.id)).map((o) => o.id)));
    setSize(sizes.find((s) => chosen.has(s.id))?.id ?? sizes[0]?.id ?? null);
    setView3d(false);
  }, [item, initial, sizes, extraOptions]);

  const hasModel = !!item?.model_url && model3d;
  useEffect(() => {
    if (!hasModel || !ar) return;
    let live = true;
    detectAr().then((m) => live && setArMode(m));
    return () => {
      live = false;
    };
  }, [hasModel, ar]);

  const unit = useMemo(() => {
    if (!item) return 0;
    const sizeDelta = sizes.find((s) => s.id === size)?.price_delta_cents ?? 0;
    return item.price_cents + sizeDelta + extraOptions.filter((o) => extras.has(o.id)).reduce((n, o) => n + o.price_delta_cents, 0);
  }, [item, sizes, size, extraOptions, extras]);

  if (!item) return null;
  const toggle = (id: string) =>
    setExtras((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    const chosen = [...sizes.filter((s) => s.id === size), ...extraOptions.filter((o) => extras.has(o.id))];
    onSubmit(
      {
        itemId: item.id,
        name: item.name,
        unitCents: item.price_cents,
        quantity,
        notes: notes.trim(),
        options: chosen.map((o) => ({ id: o.id, name: o.name, deltaCents: o.price_delta_cents })),
      },
      initial?.key ?? null,
    );
  };

  const photo = item.image_url;
  const startAr = () => {
    if (arMode === 'android' && item.model_url) window.location.href = sceneViewerUrl(item.model_url, item.name, window.location.href);
    else setView3d(true); // iPhone/iPad: o visualizador prepara a realidade aumentada e mostra o botão
  };
  const orderable = canAdd && item.available;

  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={item.name}
      footer={
        orderable ? (
          <Button size="big" block split onClick={submit}>
            <span>{initial ? 'Guardar alterações' : 'Adicionar ao pedido'}</span>
            <Money cents={unit * quantity} />
          </Button>
        ) : undefined
      }
    >
      <div className="dish-sheet">
        <div className="dish-left">
        {view3d && hasModel ? (
          <ViewerPanel
            className="dish-media"
            src={item.model_url!}
            alt={`${item.name}, ${restaurantName}`}
            poster={photo}
            ar={ar}
            title={item.name}
            fallbackUrl={window.location.href}
            onUnavailable={() => undefined}
          />
        ) : photo ? (
          <img className="dish-media dish-photo" src={photo} alt={`Fotografia de ${item.name}`} decoding="async" />
        ) : null}

        {hasModel ? (
          <div className="dish-3d">
            <button type="button" className="chip-btn" onClick={() => setView3d((v) => !v)} aria-pressed={view3d}>
              <CubeIcon /> {view3d ? (photo ? 'Ver fotografia' : 'Fechar 3D') : 'Ver em 3D'}
            </button>
            {ar && arMode ? (
              <button type="button" className="chip-btn chip-btn-gold" onClick={startAr}>
                Ver na minha mesa
              </button>
            ) : null}
          </div>
        ) : null}
        </div>

        <div className="dish-right">
        <div className="dish-info">
          <p className="dish-sheet-price voice">{kz(item.price_cents)}{sizes.length > 0 ? <span className="dish-from"> a partir de</span> : null}</p>
          {!item.available ? <p className="notice notice-danger">Este prato está esgotado de momento.</p> : null}
          {item.description ? <p className="dish-long">{item.description}</p> : null}

          {item.ingredients.length > 0 ? (
            <section aria-labelledby="dish-ing">
              <h3 id="dish-ing" className="info-title">Ingredientes</h3>
              <p className="dish-ing">{item.ingredients.join(' · ')}</p>
            </section>
          ) : null}
          {item.allergens.length > 0 ? (
            <section aria-labelledby="dish-all">
              <h3 id="dish-all" className="info-title">Contém</h3>
              <ul className="chips">
                {item.allergens.map((a) => (
                  <li key={a} className="chip chip-warn">{allergenLabel(a)}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {orderable && sizes.length > 0 ? (
          <fieldset className="extras" aria-describedby="size-hint">
            <legend className="label">Tamanho <span id="size-hint" className="hint">(escolha um)</span></legend>
            {sizes.map((o) => (
              <label key={o.id} className="check-row">
                <input type="radio" name="size" checked={size === o.id} onChange={() => setSize(o.id)} />
                <span className="check-label">{o.name}</span>
                <span className="check-price">{o.price_delta_cents > 0 ? `+ ${kz(o.price_delta_cents)}` : 'Incluído'}</span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {orderable && extraOptions.length > 0 ? (
          <fieldset className="extras">
            <legend className="label">Extras</legend>
            {extraOptions.map((o) => (
              <label key={o.id} className="check-row">
                <input type="checkbox" checked={extras.has(o.id)} onChange={() => toggle(o.id)} />
                <span className="check-label">{o.name}</span>
                <span className="check-price">{o.price_delta_cents > 0 ? `+ ${kz(o.price_delta_cents)}` : 'Grátis'}</span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {orderable ? (
          <>
            <TextArea label="Nota para a cozinha (opcional)" placeholder="Ex.: sem cebola, bem passado" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            <div className="spread">
              <span className="label">Quantidade</span>
              <Stepper label="Quantidade" value={quantity} onChange={setQuantity} min={1} max={MAX_LINE_QUANTITY} />
            </div>
          </>
        ) : null}
        </div>
      </div>
    </Sheet>
  );
}
