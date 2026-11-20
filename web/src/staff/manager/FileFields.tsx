// Campos de envio de ficheiros do gerente: fotografias (reduzidas no próprio telemóvel) e modelos 3D (GLB).
import { useId, useRef, useState } from 'react';
import { errorText } from '../../lib/api';
import { sizeText } from '../../lib/format';
import { COVER, IMAGE_ACCEPT, ImageError, LOGO, PHOTO, THUMB, prepareImage, type PrepareOptions } from '../../lib/image';
import { Button } from '../../ui/Button';
import { Sheet } from '../../ui/Sheet';
import { ViewerPanel } from '../../viewer/ViewerPanel';
import { assets } from '../data';

const PRESETS = { photo: PHOTO, logo: LOGO, cover: COVER } as const satisfies Record<string, PrepareOptions>;
export type ImagePreset = keyof typeof PRESETS;

interface ImageFieldProps {
  label: string;
  hint?: string;
  /** Endereço atual da imagem ('' = sem imagem). */
  value: string;
  preset: ImagePreset;
  onChange: (url: string) => void;
  /** Para fotografias de pratos: recebe também o endereço da miniatura (menus rápidos em telemóvel). */
  onThumb?: (url: string) => void;
  disabled?: boolean;
}

/** Escolher, enviar, trocar e remover uma imagem. A fotografia é reduzida e comprimida antes de sair do aparelho. */
export function ImageField({ label, hint, value, preset, onChange, onThumb, disabled }: ImageFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setError(null);
    try {
      setBusy('A preparar a imagem…');
      const main = await prepareImage(file, PRESETS[preset]);
      setBusy(`A enviar (${sizeText(main.blob.size)})…`);
      const up = await assets.upload(main.blob);
      let thumbUrl = '';
      if (onThumb) {
        try {
          const thumb = await prepareImage(file, THUMB);
          thumbUrl = (await assets.upload(thumb.blob)).asset.url;
        } catch {
          /* a miniatura é opcional: sem ela o menu usa a fotografia grande */
        }
        onThumb(thumbUrl);
      }
      onChange(up.asset.url);
      setBroken(null);
    } catch (err) {
      setError(err instanceof ImageError ? err.message : errorText(err));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  const remove = () => {
    setError(null);
    onChange('');
    onThumb?.('');
  };

  return (
    <div className="field">
      <span className="label" id={`${id}-l`}>
        {label}
      </span>
      <div className={`upload upload-${preset}`}>
        {value && broken !== value ? (
          <img className="upload-preview" src={value} alt="" decoding="async" onError={() => setBroken(value)} />
        ) : (
          <div className="upload-empty" aria-hidden="true">
            {value ? 'Não foi possível mostrar a imagem.' : 'Sem imagem'}
          </div>
        )}
        <div className="upload-actions">
          <input ref={input} id={id} className="sr-only" type="file" accept={IMAGE_ACCEPT} disabled={disabled || !!busy} aria-labelledby={`${id}-l`} onChange={(e) => void pick(e.target.files?.[0])} />
          <label htmlFor={id} className={`btn btn-secondary btn-sm${disabled || busy ? ' is-disabled' : ''}`}>
            {value ? 'Trocar imagem' : 'Escolher imagem'}
          </label>
          {value ? (
            <Button variant="quiet" size="sm" disabled={disabled || !!busy} onClick={remove}>
              Remover
            </Button>
          ) : null}
        </div>
      </div>
      {busy ? (
        <p className="hint" role="status">
          {busy}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint && !busy ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );
}

interface ModelFieldProps {
  /** Endereço do modelo atual ('' = sem modelo). */
  value: string;
  /** O plano do restaurante inclui pratos em 3D. */
  allowed: boolean;
  dishName: string;
  poster?: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}

const MAX_MODEL = 12 * 1024 * 1024;

/** Enviar o modelo 3D (ficheiro .glb) de um prato. Sem o 3D no plano, mostra o que falta em vez de esconder. */
export function ModelField({ value, allowed, dishName, poster, onChange, disabled }: ModelFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);

  if (!allowed) {
    return (
      <div className="field">
        <span className="label">Modelo 3D</span>
        <p className="notice" role="note">
          O plano do seu restaurante não inclui pratos em 3D. Fale com a Altiora Grupo para o ativar.
        </p>
      </div>
    );
  }

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setError(null);
    if (!/\.glb$/i.test(file.name)) {
      setError('Use um ficheiro .glb (modelo 3D).');
      return;
    }
    if (file.size > MAX_MODEL) {
      setError(`O modelo é demasiado grande (${sizeText(file.size)}). O máximo é 12 MB: reduza as texturas do modelo.`);
      return;
    }
    setBusy(true);
    try {
      const up = await assets.upload(file);
      setSize(up.asset.byte_size);
      onChange(up.asset.url);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="field">
      <span className="label" id={`${id}-l`}>
        Modelo 3D (opcional)
      </span>
      <div className="upload upload-model">
        <p className="upload-model-state">{value ? `Modelo 3D definido${size ? ` (${sizeText(size)})` : ''}.` : 'Sem modelo 3D: o menu mostra só a fotografia.'}</p>
        <div className="upload-actions">
          <input ref={input} id={id} className="sr-only" type="file" accept=".glb,model/gltf-binary" disabled={disabled || busy} aria-labelledby={`${id}-l`} onChange={(e) => void pick(e.target.files?.[0])} />
          <label htmlFor={id} className={`btn btn-secondary btn-sm${disabled || busy ? ' is-disabled' : ''}`}>
            {value ? 'Trocar modelo' : 'Escolher modelo (.glb)'}
          </label>
          {value ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setPreview(true)}>
                Pré-visualizar
              </Button>
              <Button variant="quiet" size="sm" disabled={disabled || busy} onClick={() => onChange('')}>
                Remover
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {busy ? (
        <p className="hint" role="status">
          A enviar o modelo…
        </p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="hint">Formato GLB, até 12 MB, sem ligações a ficheiros externos. Os clientes só veem o 3D se o modelo estiver aqui.</p>
      )}
      {preview && value ? (
        <Sheet open wide title={`3D — ${dishName || 'prato'}`} onClose={() => setPreview(false)}>
          <ViewerPanel className="dish-media" src={value} alt={dishName} poster={poster} ar={false} title={dishName} fallbackUrl={window.location.href} onUnavailable={() => undefined} />
          <p className="muted small">É assim que o cliente vê o prato: pode rodar e ampliar com o dedo.</p>
        </Sheet>
      ) : null}
    </div>
  );
}
