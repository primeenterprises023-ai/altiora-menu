// Informações do restaurante: horário da semana, morada, telefone, WhatsApp e e-mail (só o que o restaurante preencheu).
import { WEEKDAYS, WEEKDAY_LABELS, dayText, hasHours } from '../../../shared/hours';
import type { PublicRestaurant } from '../../../shared/types';
import { Sheet } from '../ui/Sheet';
import { ChatIcon, ClockIcon, MailIcon, PhoneIcon, PinIcon } from './icons';

const mapsHref = (r: PublicRestaurant): string | null => r.maps_url ?? (r.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name}, ${r.address}`)}` : null);
const digits = (s: string) => s.replace(/[^\d+]/g, '');

export function InfoSheet({ open, onClose, restaurant: r }: { open: boolean; onClose: () => void; restaurant: PublicRestaurant }) {
  const maps = mapsHref(r);
  const today = (() => {
    try {
      const w = new Intl.DateTimeFormat('en-US', { timeZone: r.timezone, weekday: 'short' }).format(new Date());
      return WEEKDAYS[['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(w)];
    } catch {
      return undefined;
    }
  })();
  const none = !hasHours(r.opening_hours) && !r.address && !r.phone && !r.whatsapp && !r.email;
  return (
    <Sheet open={open} onClose={onClose} title={r.name}>
      <div className="stack">
        {r.description ? <p className="muted">{r.description}</p> : null}
        {none ? <p className="muted">O restaurante ainda não indicou horário nem contactos.</p> : null}
        {hasHours(r.opening_hours) ? (
          <section aria-labelledby="info-hours">
            <h3 id="info-hours" className="info-title"><ClockIcon /> Horário</h3>
            <dl className="info-hours">
              {WEEKDAYS.map((d) => (
                <div key={d} className={d === today ? 'info-today' : undefined}>
                  <dt>{WEEKDAY_LABELS[d]}</dt>
                  <dd>{dayText(r.opening_hours[d])}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {r.address || r.phone || r.whatsapp || r.email ? (
          <section aria-labelledby="info-contacts">
            <h3 id="info-contacts" className="info-title">Contactos</h3>
            <ul className="info-list">
              {r.address ? (
                <li>
                  <PinIcon />
                  <span>{r.address}</span>
                  {maps ? <a className="info-link" href={maps} target="_blank" rel="noopener noreferrer">Ver no mapa</a> : null}
                </li>
              ) : null}
              {r.phone ? (
                <li>
                  <PhoneIcon />
                  <a href={`tel:${digits(r.phone)}`}>{r.phone}</a>
                </li>
              ) : null}
              {r.whatsapp ? (
                <li>
                  <ChatIcon />
                  <a href={`https://wa.me/${r.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
                </li>
              ) : null}
              {r.email ? (
                <li>
                  <MailIcon />
                  <a href={`mailto:${r.email}`}>{r.email}</a>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
