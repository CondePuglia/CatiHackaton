import { ErroApp } from './erros.js';
import type { Faixa } from './config.js';

/** Junta os erros por campo e devolve todos de uma vez (a tela marca cada campo). */
export class Validador {
  readonly campos: Record<string, string> = {};

  erro(campo: string, mensagem: string): void {
    if (!(campo in this.campos)) this.campos[campo] = mensagem;
  }

  texto(valor: unknown, campo: string, faixa: Faixa, rotulo: string): string {
    if (typeof valor !== 'string') {
      this.erro(campo, `Informe ${rotulo}.`);
      return '';
    }
    const limpo = valor.normalize('NFC').trim();
    const tamanho = [...limpo].length;
    if (tamanho < faixa.min || tamanho > faixa.max) {
      this.erro(campo, `Use de ${faixa.min} a ${faixa.max} caracteres em ${rotulo}.`);
    }
    return limpo;
  }

  inteiro(valor: unknown, campo: string, faixa: Faixa, mensagem: string): number {
    if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < faixa.min || valor > faixa.max) {
      this.erro(campo, mensagem);
      return 0;
    }
    return valor;
  }

  data(valor: unknown, campo: string, mensagem: string): Date {
    if (typeof valor === 'string') {
      const d = new Date(valor);
      // exige fuso explícito: "2026-11-14T15:00" sem Z dependeria do fuso do servidor (RF19)
      if (!Number.isNaN(d.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(valor.trim())) return d;
    }
    this.erro(campo, mensagem);
    return new Date(Number.NaN);
  }

  temErros(): boolean {
    return Object.keys(this.campos).length > 0;
  }

  verificar(): void {
    if (this.temErros()) {
      throw new ErroApp(422, 'VALIDACAO', 'Revise os campos destacados.', { ...this.campos });
    }
  }
}

export function objeto(corpo: unknown): Record<string, unknown> {
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) {
    throw new ErroApp(400, 'REQUISICAO_INVALIDA', 'Envie um objeto JSON no corpo da requisição.');
  }
  return corpo as Record<string, unknown>;
}

/** Converte ":id" de rota ou campo numérico em inteiro positivo. */
export function idPositivo(valor: unknown): number | null {
  const n = typeof valor === 'string' && /^\d{1,15}$/.test(valor) ? Number(valor) : valor;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}
