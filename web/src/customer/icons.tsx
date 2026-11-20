// Ícones simples (traço), desenhados à mão para o ALTIORA MENU. Herdam a cor do texto.
import type { SVGProps } from 'react';

const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false } as const;
type P = SVGProps<SVGSVGElement>;

export const SearchIcon = (p: P) => (<svg {...base} {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>);
export const BellIcon = (p: P) => (<svg {...base} {...p}><path d="M6 17h12l-1.5-2.2V10a4.5 4.5 0 0 0-9 0v4.8L6 17Z" /><path d="M10 20a2 2 0 0 0 4 0" /><path d="M12 5.5V4" /></svg>);
export const InfoIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>);
export const CubeIcon = (p: P) => (<svg {...base} {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5" /><path d="M12 12v9" /></svg>);
export const SlidersIcon = (p: P) => (<svg {...base} {...p}><path d="M4 7h9" /><path d="M17 7h3" /><circle cx="15" cy="7" r="2" /><path d="M4 17h3" /><path d="M11 17h9" /><circle cx="9" cy="17" r="2" /></svg>);
export const PinIcon = (p: P) => (<svg {...base} {...p}><path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></svg>);
export const PhoneIcon = (p: P) => (<svg {...base} {...p}><path d="M6.5 4h3l1.5 4-2 1.3a11 11 0 0 0 5.7 5.7L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z" /></svg>);
export const ChatIcon = (p: P) => (<svg {...base} {...p}><path d="M5 18.5 6 15a7.5 7.5 0 1 1 3 2.9L5 18.5Z" /></svg>);
export const MailIcon = (p: P) => (<svg {...base} {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></svg>);
export const ClockIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>);
export const CloseIcon = (p: P) => (<svg {...base} {...p}><path d="m6 6 12 12M18 6 6 18" /></svg>);
export const PlusIcon = (p: P) => (<svg {...base} strokeWidth={2.2} {...p}><path d="M12 5v14M5 12h14" /></svg>);
export const ArrowIcon = (p: P) => (<svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>);
