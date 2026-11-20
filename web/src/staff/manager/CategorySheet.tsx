import { useLayoutEffect, useState } from 'react';
import type { StaffMenu, StaffMenuCategory } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Switch, TextField } from '../../ui/Fields';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { menu as menuApi } from '../data';
import { fieldErrors, nextOrder } from '../forms';
import { ConfirmSheet } from '../orders/ConfirmSheet';

interface Props {
  /** null = fechada; categoryId null = nova categoria. */
  state: { categoryId: string | null } | null;
  menu: StaffMenu | undefined;
  onClose: () => void;
  onChanged: () => void;
}

export function CategorySheet({ state, menu, onClose, onChanged }: Props) {
  const toast = useToast();
  const category: StaffMenuCategory | undefined = state?.categoryId ? menu?.categories.find((c) => c.id === state.categoryId) : undefined;
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);

  const key = state ? (state.categoryId ?? 'nova') : null;
  useLayoutEffect(() => {
    if (key === null) return;
    setName(category?.name ?? '');
    setActive(category?.active ?? true);
    setBusy(false);
    setError(null);
    setErrors({});
    // só ao abrir (ou ao mudar de categoria)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!state) return null;

  const save = async () => {
    if (busy) return;
    if (!name.trim()) {
      setErrors({ name: 'Indique o nome da categoria.' });
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      if (category) {
        await menuApi.updateCategory(category.id, { name: name.trim(), active });
        toast.show('Categoria guardada.');
      } else {
        await menuApi.createCategory({ name: name.trim(), active, display_order: nextOrder(menu?.categories ?? []) });
        toast.show('Categoria criada.');
      }
      onChanged();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!category) return;
    await menuApi.deleteCategory(category.id);
    toast.show('Categoria apagada.');
    setDeleting(false);
    onChanged();
    onClose();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        locked={busy}
        title={category ? 'Editar categoria' : 'Nova categoria'}
        footer={
          <div className="stack-sm">
            <Button size="big" block loading={busy} onClick={() => void save()}>
              {category ? 'Guardar' : 'Criar categoria'}
            </Button>
            {category ? (
              <Button variant="danger-quiet" block disabled={busy} onClick={() => setDeleting(true)}>
                Apagar categoria
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
          <TextField label="Nome" value={name} maxLength={80} error={errors.name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Entradas" autoComplete="off" />
          <Switch checked={active} onChange={setActive} label="Mostrar esta categoria no menu" />
          {!active ? <p className="muted small">Enquanto estiver escondida, os clientes não veem a categoria nem os pratos que tem.</p> : null}
        </div>
      </Sheet>
      <ConfirmSheet open={deleting} danger title="Apagar categoria" confirmLabel="Apagar categoria" onClose={() => setDeleting(false)} onConfirm={remove}>
        <p>
          Vai apagar a categoria <strong>{category?.name}</strong>. Só é possível se não tiver pratos; se tiver, mude os pratos para outra categoria ou
          esconda esta categoria.
        </p>
      </ConfirmSheet>
    </>
  );
}
