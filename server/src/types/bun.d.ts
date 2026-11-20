// Declarações mínimas das APIs do Bun usadas pelo servidor (só para verificação de tipos).
// Em execução usa-se o Bun real; num ambiente com o pacote "bun-types" este ficheiro pode ser removido.

declare module 'bun' {
  export type Row = Record<string, any>;

  export interface TxSql {
    <T = Row>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]>;
    unsafe<T = Row>(query: string, params?: any[]): Promise<T[]>;
  }

  export interface SQLOptions {
    url?: string;
    max?: number;
    idleTimeout?: number;
    connectionTimeout?: number;
    maxLifetime?: number;
    tls?: boolean | Record<string, unknown>;
    prepare?: boolean;
  }

  export interface SQL extends TxSql {
    begin<T>(fn: (tx: TxSql) => Promise<T>): Promise<T>;
    close(options?: { timeout?: number }): Promise<void>;
  }
  export const SQL: { new (urlOrOptions: string | SQLOptions): SQL };

  export interface BunFile extends Blob {
    exists(): Promise<boolean>;
    readonly name?: string;
    readonly lastModified: number;
  }

  export interface ServerLike {
    port: number;
    hostname: string;
    stop(closeActiveConnections?: boolean): Promise<void> | void;
    requestIP(req: Request): { address: string; family: string; port: number } | null;
    timeout(req: Request, seconds: number): void;
  }

  export function serve(options: {
    port?: number;
    hostname?: string;
    idleTimeout?: number;
    maxRequestBodySize?: number;
    fetch(req: Request, server: ServerLike): Response | Promise<Response>;
    error?(err: Error): Response | Promise<Response>;
  }): ServerLike;

  export function file(path: string, options?: { type?: string }): BunFile;

  export interface BuildResult {
    success: boolean;
    logs: unknown[];
    outputs: Array<{ path: string; kind: string }>;
  }
  /** Construção de pacotes (usada só por scripts/build.ts). */
  export function build(options: {
    entrypoints: string[];
    outdir?: string;
    naming?: string;
    target?: 'bun' | 'node' | 'browser';
    minify?: boolean;
    sourcemap?: 'none' | 'linked' | 'inline' | 'external';
  }): Promise<BuildResult>;
  export function sleep(ms: number): Promise<void>;
  export const version: string;
}

declare const Bun: typeof import('bun');

// Executor de testes do Bun (só para verificação de tipos dos ficheiros de teste).
declare module 'bun:test' {
  type TestFn = (name: string, fn: () => void | Promise<void>, timeout?: number) => void;
  interface TestApi extends TestFn {
    skip: TestFn;
    todo: (name: string) => void;
    only: TestFn;
    if: (condition: boolean) => TestFn;
    each: <T>(cases: readonly T[]) => (name: string, fn: (c: T) => void | Promise<void>) => void;
  }
  export const test: TestApi;
  export const it: TestApi;
  export function describe(name: string, fn: () => void): void;
  export namespace describe {
    function skip(name: string, fn: () => void): void;
    function each<T>(cases: readonly T[]): (name: string, fn: (c: T) => void) => void;
  }
  export function beforeAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  interface ExpectApi {
    (value: unknown): any;
    any(constructor: unknown): any;
    anything(): any;
    stringContaining(text: string): any;
    stringMatching(pattern: string | RegExp): any;
    arrayContaining(items: readonly unknown[]): any;
    objectContaining(obj: Record<string, unknown>): any;
    assertions(count: number): void;
  }
  export const expect: ExpectApi;
}

interface ImportMeta {
  dir: string;
  path: string;
}
