// Constrói a aplicação para publicar:
//   dist/server.js   o servidor num único ficheiro (corre com: bun dist/server.js)
//   dist/web/        a aplicação web (HTML, CSS, JS e tipos de letra, já comprimidos)
//
//   bun run build
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');
const webOut = join(dist, 'web');

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function buildServer(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, 'server/src/main.ts')],
    outdir: dist,
    naming: 'server.js',
    target: 'bun',
    minify: false,
    sourcemap: 'none',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error('Falhou a construção do servidor.');
  }
  const size = (await stat(join(dist, 'server.js'))).size;
  console.log(`servidor        dist/server.js  ${kb(size)}`);
}

async function buildWeb(): Promise<void> {
  const landingEntry = join(root, 'web/src/landing/landing.ts');
  const entryPoints: Record<string, string> = { main: join(root, 'web/src/main.tsx') };
  if (existsSync(landingEntry)) entryPoints.landing = landingEntry; // página comercial (servida pelo servidor, sem React)
  const result = await esbuild.build({
    entryPoints,
    outdir: join(webOut, 'assets'),
    entryNames: '[name]-[hash]',
    chunkNames: 'chunk-[hash]',
    assetNames: '[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    minify: true,
    // ES2019: corre também em telemóveis Android antigos e em iPhones que já não recebem atualizações
    target: ['es2019'],
    jsx: 'automatic',
    loader: { '.woff': 'file', '.woff2': 'file' },
    // o Three.js (motor 3D) vem incluído em web/vendor/three: só é descarregado quando alguém abre um prato em 3D
    alias: { 'three/addons': join(root, 'web/vendor/three/examples/jsm'), three: join(root, 'web/vendor/three/build/three.module.js') },
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'linked',
    metafile: true,
    logLevel: 'warning',
  });

  const outputs = Object.entries(result.metafile.outputs);
  const entry = outputs.find(([, o]) => o.entryPoint?.endsWith('web/src/main.tsx'));
  if (!entry) throw new Error('Não encontrei o ficheiro principal da aplicação web.');
  const entryJs = basename(entry[0]);
  const entryCss = basename(entry[1].cssBundle ?? '');
  if (!entryCss) throw new Error('Não encontrei o ficheiro de estilos.');
  const font = outputs.map(([file]) => basename(file)).find((f) => f.endsWith('.woff') || f.endsWith('.woff2'));
  const landing = outputs.find(([, o]) => o.entryPoint?.endsWith('web/src/landing/landing.ts'));
  const manifest: Record<string, string> = { 'main.js': `/assets/${entryJs}`, 'main.css': `/assets/${entryCss}` };
  if (font) manifest.font = `/assets/${font}`;
  if (landing) {
    manifest['landing.js'] = `/assets/${basename(landing[0])}`;
    if (landing[1].cssBundle) manifest['landing.css'] = `/assets/${basename(landing[1].cssBundle)}`;
  }

  // ficheiros públicos (ícones, manifesto, robots) vão para a raiz
  await cp(join(root, 'web/public'), webOut, { recursive: true });

  // index.html: o esbuild não o gera, por isso juntamos nós os endereços com o código de controlo (hash) no nome
  const template = await readFile(join(root, 'web/index.html'), 'utf8');
  if (!template.includes('<!--assets-->')) throw new Error('web/index.html não tem a marca <!--assets-->.');
  const tags = [
    font ? `<link rel="preload" href="/assets/${font}" as="font" type="font/${extname(font).slice(1)}" crossorigin />` : '',
    `<link rel="stylesheet" href="/assets/${entryCss}" />`,
    `<script type="module" src="/assets/${entryJs}"></script>`,
  ]
    .filter(Boolean)
    .join('\n    ');
  await writeFile(join(webOut, 'index.html'), template.replace('<!--assets-->', tags));
  await writeFile(join(webOut, 'asset-manifest.json'), JSON.stringify(manifest, null, 2));

  // o código sem comentários legais não pode ser publicado sem a lista de licenças: ver docs/licencas.md
  const sizes = new Map<string, number>();
  for (const [file, meta] of outputs) sizes.set(basename(file), meta.bytes);
  const main = sizes.get(entryJs) ?? 0;
  const css = sizes.get(entryCss) ?? 0;
  console.log(`aplicação web   ${entryJs}  ${kb(main)}  |  ${entryCss}  ${kb(css)}`);
}

/** Guarda versões comprimidas ao lado de cada ficheiro: o servidor entrega-as sem comprimir a cada pedido. */
async function precompress(): Promise<void> {
  const compressible = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt']);
  let plain = 0;
  let br = 0;
  let gz = 0;
  for (const file of await walk(webOut)) {
    if (!compressible.has(extname(file))) continue;
    const data = await readFile(file);
    if (data.byteLength < 1024) continue;
    const brotli = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength } });
    const gzip = gzipSync(data, { level: 9 });
    await writeFile(`${file}.br`, brotli);
    await writeFile(`${file}.gz`, gzip);
    if (basename(file).startsWith('main-')) {
      plain += data.byteLength;
      br += brotli.byteLength;
      gz += gzip.byteLength;
    }
  }
  console.log(`principal       sem comprimir ${kb(plain)}  |  gzip ${kb(gz)}  |  brotli ${kb(br)}   (JS + CSS que o cliente descarrega)`);
}

async function report(): Promise<void> {
  const files = (await walk(webOut)).filter((f) => !f.endsWith('.br') && !f.endsWith('.gz'));
  console.log(`\nFicheiros em dist/web: ${files.length}`);
  for (const f of files.sort()) console.log(`  ${relative(webOut, f).padEnd(44)} ${kb((await stat(f)).size)}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  await rm(dist, { recursive: true, force: true });
  await mkdir(webOut, { recursive: true });
  await buildServer();
  await buildWeb();
  await precompress();
  await report();
  console.log(`\nConstruído em ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

main().catch((err) => {
  console.error('\nFalhou a construção:', err instanceof Error ? err.message : err);
  process.exit(1);
});
