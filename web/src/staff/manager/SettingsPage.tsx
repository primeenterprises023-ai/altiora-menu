// Definições do restaurante (só o gerente): pausa dos pedidos por QR Code, dados, cor e imagens do menu, taxa de serviço e fuso horário.
import { useEffect, useState } from 'react';
import { WEEKDAYS, isTime, type OpeningHours, type TimeRange } from '../../../../shared/hours';
import type { RestaurantSettings } from '../../../../shared/types';
import { errorText } from '../../lib/api';
import { Link } from '../../lib/router';
import { accentVars, parseHex } from '../../lib/theme';
import { Button } from '../../ui/Button';
import { SelectField, Switch, TextArea, TextField } from '../../ui/Fields';
import { Loading } from '../../ui/States';
import { useToast } from '../../ui/Toast';
import { restaurant as restaurantApi } from '../data';
import { bpsToPercentText, fieldErrors, parsePercentToBps } from '../forms';
import { useDocumentTitle } from '../hooks';
import { useFeatures, type Features } from '../features';
import { useRestaurant } from '../Shell';
import { ImageField } from './FileFields';
import { HoursEditor } from './HoursEditor';

const DEFAULT_ACCENT = '#c9a24b';

const ZONES: Array<[string, string]> = [
  ['Africa/Luanda', 'Angola (Luanda)'],
  ['Europe/Lisbon', 'Portugal (Lisboa)'],
  ['Africa/Maputo', 'Moçambique (Maputo)'],
  ['Atlantic/Cape_Verde', 'Cabo Verde'],
  ['Africa/Sao_Tome', 'São Tomé e Príncipe'],
  ['America/Sao_Paulo', 'Brasil (São Paulo)'],
  ['UTC', 'Hora universal (UTC)'],
];

const CURRENCY_NAMES: Record<string, string> = {
  AOA: 'Kwanza angolano (Kz)',
  USD: 'Dólar americano (US$)',
  EUR: 'Euro (€)',
  BRL: 'Real brasileiro (R$)',
  MZN: 'Metical moçambicano',
  CVE: 'Escudo cabo-verdiano',
  ZAR: 'Rand sul-africano',
  GBP: 'Libra esterlina (£)',
};

interface FormState {
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  whatsapp: string;
  maps: string;
  hours: OpeningHours;
  accent: string;
  theme: 'dark' | 'light';
  font: 'serif' | 'sans';
  logo: string;
  cover: string;
  fee: string;
  timezone: string;
}

/** Horário limpo e sempre na mesma ordem, para comparar "mudou ou não". */
function normHours(h: OpeningHours): OpeningHours {
  const out: OpeningHours = {};
  for (const d of WEEKDAYS) {
    const ranges = (h[d] ?? []).map(([a, b]) => [a, b] as TimeRange);
    if (ranges.length > 0) out[d] = ranges;
  }
  return out;
}

const toForm = (r: RestaurantSettings): FormState => ({
  name: r.name,
  description: r.description ?? '',
  address: r.address ?? '',
  phone: r.phone ?? '',
  email: r.email ?? '',
  whatsapp: r.whatsapp ? `+${r.whatsapp}` : '',
  maps: r.maps_url ?? '',
  hours: normHours(r.opening_hours),
  accent: r.accent_color ?? '',
  theme: r.theme,
  font: r.font,
  logo: r.logo_url ?? '',
  cover: r.cover_url ?? '',
  fee: bpsToPercentText(r.service_fee_bps),
  timezone: r.timezone,
});

const trimmed = (f: FormState): FormState => ({
  name: f.name.trim(),
  description: f.description.trim(),
  address: f.address.trim(),
  phone: f.phone.trim(),
  email: f.email.trim().toLowerCase(),
  whatsapp: f.whatsapp.replace(/[\s().+-]/g, ''),
  maps: f.maps.trim(),
  hours: normHours(f.hours),
  accent: f.accent.trim().toLowerCase(),
  theme: f.theme,
  font: f.font,
  logo: f.logo.trim(),
  cover: f.cover.trim(),
  // "12,5 %" e "12,5" são a mesma taxa: comparam-se em pontos base; texto inválido compara-se tal como está
  fee: (() => {
    const bps = parsePercentToBps(f.fee);
    return bps === null ? f.fee.trim() : String(bps);
  })(),
  timezone: f.timezone,
});

/** Nome do campo no formulário → nome do campo na API (para mostrar o erro no sítio certo). */
const ERROR_KEY: Partial<Record<keyof FormState, string>> = { fee: 'service_fee_bps', accent: 'accent_color', logo: 'logo_url', cover: 'cover_url', maps: 'maps_url', hours: 'opening_hours' };

function AccentPreview({ hex }: { hex: string }) {
  const v = accentVars(parseHex(hex) ? hex : DEFAULT_ACCENT)!;
  return (
    <div className="accent-preview" aria-hidden="true">
      <span className="accent-preview-btn" style={{ background: v.accent, color: v.onAccent }}>
        Botão de exemplo
      </span>
      <span className="accent-preview-text" style={{ color: v.textLight }}>
        Texto com a cor
      </span>
    </div>
  );
}

function Settings({ base, onSaved }: { base: RestaurantSettings; onSaved: (r: RestaurantSettings) => void }) {
  const toast = useToast();
  const features = useFeatures();
  const [saved, setSaved] = useState(base);
  const [form, setForm] = useState<FormState>(() => toForm(base));
  // A pausa pode ser mudada noutro sítio (a faixa "Retomar pedidos" do topo): acompanha sempre o valor mais recente do restaurante.
  const [accepting, setAccepting] = useState(base.accepting_orders);
  useEffect(() => {
    setAccepting(base.accepting_orders);
  }, [base.accepting_orders]);
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [ERROR_KEY[key] ?? key]: '' }));
  };
  const dirty = JSON.stringify(trimmed(form)) !== JSON.stringify(trimmed(toForm(saved)));
  const zones = ZONES.some(([z]) => z === form.timezone) ? ZONES : [...ZONES, [form.timezone, form.timezone] as [string, string]];
  const swatch = parseHex(form.accent.trim()) ? form.accent.trim().toLowerCase() : DEFAULT_ACCENT;

  const apply = (r: RestaurantSettings) => {
    setSaved(r);
    onSaved(r);
  };

  const togglePause = async (next: boolean) => {
    if (pausing) return;
    setPausing(true);
    try {
      const res = await restaurantApi.update({ accepting_orders: next });
      setAccepting(res.restaurant.accepting_orders);
      onSaved(res.restaurant);
      toast.show(next ? 'Pedidos por QR Code retomados.' : 'Pedidos por QR Code pausados.');
    } catch (err) {
      toast.show(errorText(err), 'danger');
    } finally {
      setPausing(false);
    }
  };

  const save = async () => {
    if (busy || !dirty) return;
    setError(null);
    const f = trimmed(form);
    const b = trimmed(toForm(saved));
    const problems: Record<string, string> = {};
    if (f.name.length < 2) problems.name = 'Escreva o nome do restaurante (pelo menos 2 letras).';
    const bps = parsePercentToBps(form.fee);
    if (bps === null) problems.service_fee_bps = 'Indique uma percentagem de 0 a 30, por exemplo 10 ou 12,5.';
    if (f.accent && !parseHex(f.accent)) problems.accent_color = 'Use uma cor no formato #RRGGBB, por exemplo #0f6d7a.';
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) problems.email = 'Escreva um email válido, por exemplo geral@restaurante.ao.';
    if (f.whatsapp && !/^[0-9]{8,15}$/.test(f.whatsapp)) problems.whatsapp = 'Escreva o número com o indicativo do país, por exemplo +244 923 000 000.';
    if (f.maps && !/^https:\/\/\S+$/i.test(f.maps)) problems.maps_url = 'Use um endereço que comece por https://';
    if (WEEKDAYS.some((d) => (f.hours[d] ?? []).some(([x, y]) => !isTime(x) || !isTime(y) || x === y))) {
      problems.opening_hours = 'Confirme os horários: todas as horas preenchidas, e a abertura diferente do fecho.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;

    const changes: Record<string, unknown> = {};
    if (f.name !== b.name) changes.name = f.name;
    if (f.description !== b.description) changes.description = f.description || null;
    if (f.address !== b.address) changes.address = f.address || null;
    if (f.phone !== b.phone) changes.phone = f.phone || null;
    if (f.email !== b.email) changes.email = f.email || null;
    if (f.whatsapp !== b.whatsapp) changes.whatsapp = f.whatsapp || null;
    if (f.maps !== b.maps) changes.maps_url = f.maps || null;
    if (JSON.stringify(f.hours) !== JSON.stringify(b.hours)) changes.opening_hours = f.hours;
    if (f.theme !== b.theme) changes.theme = f.theme;
    if (f.font !== b.font) changes.font = f.font;
    if (f.accent !== b.accent) changes.accent_color = f.accent || null;
    if (f.logo !== b.logo) changes.logo_url = f.logo || null;
    if (f.cover !== b.cover) changes.cover_url = f.cover || null;
    if (bps !== null && bps !== saved.service_fee_bps) changes.service_fee_bps = bps;
    if (f.timezone !== b.timezone) changes.timezone = f.timezone;
    if (Object.keys(changes).length === 0) {
      setForm(toForm(saved));
      return;
    }

    setBusy(true);
    try {
      const res = await restaurantApi.update(changes);
      apply(res.restaurant);
      setForm(toForm(res.restaurant));
      toast.show('Definições guardadas.');
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(fields);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title voice">Definições</h1>
        </div>
      </div>

      <div className="settings stack-lg">
        <section className="settings-block stack" aria-labelledby="st-orders">
          <h2 className="section-title" id="st-orders">
            Pedidos por QR Code
          </h2>
          <Switch checked={accepting} disabled={pausing} onChange={(v) => void togglePause(v)} label="Aceitar pedidos dos clientes" />
          <p className="muted small">
            {accepting
              ? 'Os clientes podem enviar pedidos a partir do QR Code da mesa. Desligue para fazer uma pausa (por exemplo, perto da hora de fecho): continuam a ver o menu, mas não enviam pedidos. Os pedidos registados pela equipa continuam a funcionar.'
              : 'Pausado: os clientes veem o menu mas não conseguem enviar pedidos. Os pedidos registados pela equipa continuam a funcionar. Volte a ligar quando quiser retomar.'}
          </p>
        </section>

        <form
          className="stack-lg"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && Object.values(errors).every((v) => !v) ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}

          <section className="settings-block stack" aria-labelledby="st-data">
            <h2 className="section-title" id="st-data">
              Dados do restaurante
            </h2>
            <TextField label="Nome" value={form.name} maxLength={120} autoComplete="off" error={errors.name} onChange={(e) => set('name', e.target.value)} />
            <TextArea
              label="Descrição (opcional)"
              value={form.description}
              maxLength={500}
              rows={3}
              hint="Aparece no topo do menu dos clientes."
              error={errors.description}
              onChange={(e) => set('description', e.target.value)}
            />
            <TextField label="Morada (opcional)" value={form.address} maxLength={200} autoComplete="off" error={errors.address} onChange={(e) => set('address', e.target.value)} />
            <TextField
              label="Localização no mapa (opcional)"
              type="url"
              inputMode="url"
              value={form.maps}
              maxLength={500}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://maps.google.com/…"
              hint="Abra o seu restaurante no Google Maps, escolha «Partilhar» e cole aqui a ligação."
              error={errors.maps_url}
              onChange={(e) => set('maps', e.target.value)}
            />
            <div className="field-row">
              <TextField label="Telefone (opcional)" type="tel" value={form.phone} maxLength={40} autoComplete="off" error={errors.phone} onChange={(e) => set('phone', e.target.value)} />
              <TextField label="Email (opcional)" type="email" value={form.email} maxLength={160} autoComplete="off" autoCapitalize="none" error={errors.email} onChange={(e) => set('email', e.target.value)} />
            </div>
            <TextField
              label="WhatsApp para pedidos (opcional)"
              type="tel"
              value={form.whatsapp}
              maxLength={40}
              autoComplete="off"
              disabled={!features.has('whatsapp_orders')}
              placeholder="+244 923 000 000"
              hint={
                features.has('whatsapp_orders') ? (
                  'Com o indicativo do país. Os clientes podem enviar o pedido já escrito para este número.'
                ) : (
                  <>
                    Pedidos por WhatsApp não estão incluídos no seu plano. <Link to="/gerente/plano">Ver o plano</Link>
                  </>
                )
              }
              error={errors.whatsapp}
              onChange={(e) => set('whatsapp', e.target.value)}
            />
          </section>

          <section className="settings-block stack" aria-labelledby="st-hours">
            <h2 className="section-title" id="st-hours">
              Horário de funcionamento
            </h2>
            <HoursEditor value={form.hours} onChange={(h) => set('hours', h)} error={errors.opening_hours} />
          </section>

          <section className="settings-block stack" aria-labelledby="st-look">
            <h2 className="section-title" id="st-look">
              Aspeto do menu
            </h2>
            <ImageField label="Logótipo (opcional)" preset="logo" value={form.logo} onChange={(u) => set('logo', u)} hint="De preferência quadrado ou redondo, com fundo transparente (PNG)." />
            <ImageField label="Imagem de capa (opcional)" preset="cover" value={form.cover} onChange={(u) => set('cover', u)} hint="Fotografia larga do restaurante ou dos pratos. É reduzida e recortada automaticamente." />
            <BrandingFields form={form} errors={errors} set={set} features={features} swatch={swatch} />
          </section>

          <section className="settings-block stack" aria-labelledby="st-money">
            <h2 className="section-title" id="st-money">
              Taxa de serviço e hora
            </h2>
            <TextField
              label="Taxa de serviço (%)"
              value={form.fee}
              inputMode="decimal"
              maxLength={6}
              autoComplete="off"
              hint="Somada a cada pedido novo, calculada pelo servidor. Use 0 se não cobra. Os pedidos já feitos não mudam."
              error={errors.service_fee_bps}
              onChange={(e) => set('fee', e.target.value)}
            />
            <SelectField
              label="Fuso horário"
              value={form.timezone}
              hint="Define o dia a que cada pedido pertence (números dos pedidos e relatórios). Só mude se o restaurante mudou de fuso."
              error={errors.timezone}
              onChange={(e) => set('timezone', e.target.value)}
            >
              {zones.map(([zone, label]) => (
                <option key={zone} value={zone}>
                  {label}
                </option>
              ))}
            </SelectField>
          </section>

          <div className={`settings-actions${dirty || busy ? '' : ' is-clean'}`}>
            <Button type="submit" size="big" block loading={busy} disabled={!dirty}>
              Guardar alterações
            </Button>
            {dirty ? <p className="muted small settings-dirty">Tem alterações por guardar.</p> : null}
          </div>
        </form>

        <section className="settings-block stack" aria-labelledby="st-info">
          <h2 className="section-title" id="st-info">
            Informação
          </h2>
          <dl className="cred-rows">
            <div>
              <dt>Endereço dos QR Codes</dt>
              <dd>{saved.menu_base_url ?? window.location.origin}</dd>
            </div>
            <div>
              <dt>Identificador</dt>
              <dd>{saved.slug}</dd>
            </div>
            <div>
              <dt>Moeda</dt>
              <dd>{CURRENCY_NAMES[saved.currency] ?? saved.currency}</dd>
            </div>
          </dl>
          <p className="muted small">Estes dados são geridos pela Altiora Grupo. Se o endereço mudar, será preciso imprimir de novo os QR Codes das mesas.</p>
        </section>
      </div>
    </div>
  );
}

type SetField = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

function PlanLock({ children }: { children: string }) {
  return (
    <p className="hint">
      {children} <Link to="/gerente/plano">Ver o plano</Link>
    </p>
  );
}

/** Cor, tema e letra do menu: cada uma só se o plano a incluir (as outras ficam visíveis, mas bloqueadas). */
function BrandingFields({ form, errors, set, features, swatch }: { form: FormState; errors: Record<string, string>; set: SetField; features: Features; swatch: string }) {
  const colors = features.has('advanced_branding');
  const exclusive = features.has('exclusive_branding');
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="st-accent">
          Cor do restaurante
        </label>
        <div className="color-row">
          <input type="color" className="color-input" aria-label="Escolher a cor" value={swatch} disabled={!colors} onChange={(e) => set('accent', e.target.value)} />
          <input
            id="st-accent"
            className="input color-hex"
            value={form.accent}
            placeholder={DEFAULT_ACCENT}
            maxLength={7}
            autoComplete="off"
            spellCheck={false}
            disabled={!colors}
            aria-invalid={errors.accent_color ? true : undefined}
            onChange={(e) => set('accent', e.target.value)}
          />
          {form.accent && colors ? (
            <Button variant="quiet" size="sm" onClick={() => set('accent', '')}>
              Cor padrão
            </Button>
          ) : null}
        </div>
        {errors.accent_color ? (
          <p className="field-error" role="alert">
            {errors.accent_color}
          </p>
        ) : colors ? (
          <p className="hint">Usada nos botões e destaques do menu e do painel. O texto ajusta-se sozinho para ficar legível.</p>
        ) : (
          <PlanLock>A cor própria não está incluída no seu plano.</PlanLock>
        )}
        <AccentPreview hex={form.accent} />
      </div>

      <fieldset className="field choice" disabled={!colors}>
        <legend className="label">Tema do menu</legend>
        <label className="check-row">
          <input type="radio" name="st-theme" checked={form.theme === 'dark'} onChange={() => set('theme', 'dark')} />
          <span className="check-label">Escuro (preto e dourado)</span>
        </label>
        <label className="check-row">
          <input type="radio" name="st-theme" checked={form.theme === 'light'} onChange={() => set('theme', 'light')} />
          <span className="check-label">Claro (branco)</span>
        </label>
        {colors ? null : <PlanLock>A escolha do tema não está incluída no seu plano.</PlanLock>}
      </fieldset>

      <fieldset className="field choice" disabled={!exclusive}>
        <legend className="label">Estilo de letra dos títulos</legend>
        <label className="check-row">
          <input type="radio" name="st-font" checked={form.font === 'serif'} onChange={() => set('font', 'serif')} />
          <span className="check-label">Elegante (serifada)</span>
        </label>
        <label className="check-row">
          <input type="radio" name="st-font" checked={form.font === 'sans'} onChange={() => set('font', 'sans')} />
          <span className="check-label">Moderna (sem serifa)</span>
        </label>
        {exclusive ? <p className="hint">Com a personalização exclusiva, o menu dos clientes não mostra a marca Altiora.</p> : <PlanLock>A personalização exclusiva não está incluída no seu plano.</PlanLock>}
      </fieldset>
    </>
  );
}

export default function SettingsPage() {
  const { restaurant, reload } = useRestaurant();
  useDocumentTitle('Definições');
  if (!restaurant) return <Loading rows={4} />;
  return <Settings key={restaurant.id} base={restaurant} onSaved={() => reload()} />;
}
