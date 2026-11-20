// Mensagens de validação em português (Zod).
import { z } from 'zod';

const TYPES: Record<string, string> = {
  string: 'texto',
  number: 'número',
  integer: 'número inteiro',
  boolean: 'verdadeiro/falso',
  array: 'lista',
  object: 'objeto',
  date: 'data',
};

export const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') return { message: 'Campo obrigatório.' };
      return { message: `Valor inválido: era esperado ${TYPES[issue.expected] ?? issue.expected}.` };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: issue.minimum === 1 ? 'Campo obrigatório.' : `Tem de ter pelo menos ${issue.minimum} caracteres.` };
      if (issue.type === 'array') return { message: `Indique pelo menos ${issue.minimum} elemento(s).` };
      return { message: `O valor mínimo é ${issue.minimum}.` };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `Pode ter no máximo ${issue.maximum} caracteres.` };
      if (issue.type === 'array') return { message: `Indique no máximo ${issue.maximum} elemento(s).` };
      return { message: `O valor máximo é ${issue.maximum}.` };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'E-mail inválido.' };
      if (issue.validation === 'uuid') return { message: 'Identificador inválido.' };
      if (issue.validation === 'url') return { message: 'Endereço inválido.' };
      return { message: 'Formato inválido.' };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor inválido. Opções: ${issue.options.join(', ')}.` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Campos não permitidos: ${issue.keys.join(', ')}.` };
    case z.ZodIssueCode.invalid_union:
      return { message: 'Valor inválido.' };
    default:
      return { message: ctx.defaultError };
  }
};

let installed = false;
export function installZodPt(): void {
  if (installed) return;
  z.setErrorMap(ptErrorMap);
  installed = true;
}

/** Converte um ZodError numa lista simples campo -> mensagem. */
export function zodDetails(err: z.ZodError): Array<{ field: string; message: string }> {
  return err.issues.slice(0, 20).map((i) => ({ field: i.path.join('.') || '(corpo)', message: i.message }));
}
