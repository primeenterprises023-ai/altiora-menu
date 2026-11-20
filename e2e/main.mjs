// Corre os cenários dos ensaios de ponta a ponta, por ordem, contra um servidor já ligado (ver e2e/run.ts).
// Termina com código 0 se tudo passou e 1 se alguma verificação falhou.
//   E2E_ONLY=02,05   corre só os cenários cujos ficheiros começam por esses números (útil ao afinar um ensaio)
import { chromium } from 'playwright';
import { BASE, OUT, allResults, apiAs, check, loadTables } from './lib.mjs';
import * as cliente from './specs/01-cliente.mjs';
import * as tempoReal from './specs/02-tempo-real.mjs';
import * as seguranca from './specs/03-seguranca.mjs';
import * as casosLimite from './specs/04-casos-limite.mjs';
import * as qrGerente from './specs/05-qr-gerente.mjs';
import * as altioraMenu from './specs/06-altiora-menu.mjs';
import * as garcom from './specs/07-garcom.mjs';

const specs = [
  ['01', cliente],
  ['02', tempoReal],
  ['03', seguranca],
  ['04', casosLimite],
  ['05', qrGerente],
  ['06', altioraMenu],
  ['07', garcom],
];
const only = (process.env.E2E_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const started = Date.now();
const browser = await chromium.launch();
try {
  console.log(`Ensaios de ponta a ponta contra ${BASE} (ecrãs de exemplo em ${OUT})`);
  const manager = await apiAs(browser, 'gerente@terraza.demo');
  const kitchen = await apiAs(browser, 'cozinha@terraza.demo');
  const waiter = await apiAs(browser, 'empregado@terraza.demo');
  const platform = await apiAs(browser, 'admin@altiora.demo');
  const tables = await loadTables(manager);
  check('as contas de demonstração entram e as 8 mesas existem', tables.size === 8, `${tables.size} mesas`);
  const env = { browser, manager, kitchen, waiter, platform, tables };
  for (const [id, spec] of specs) {
    if (only.length > 0 && !only.includes(id)) continue;
    await spec.run(env);
  }
} catch (e) {
  check('os ensaios correram até ao fim', false, e?.stack ?? e);
} finally {
  await browser.close();
}

const all = allResults();
const failed = all.filter((r) => !r.ok);
const skipped = all.filter((r) => r.skipped);
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\n${all.length - failed.length - skipped.length} verificações passaram, ${failed.length} falharam, ${skipped.length} foram saltadas (${seconds} s).`);
for (const f of failed) console.log(`  FALHOU: ${f.name}`);
process.exit(failed.length > 0 ? 1 : 0);
