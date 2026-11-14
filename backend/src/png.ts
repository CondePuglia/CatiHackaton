import { crc32, deflateSync } from 'node:zlib';

/**
 * Codificador PNG mínimo (RGB, 8 bits), sem dependência nativa.
 * Serve para gerar as fotos dos dados de demonstração e dos testes.
 */
function bloco(tipo: string, dados: Buffer): Buffer {
  const cabecalho = Buffer.from(tipo, 'latin1');
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const soma = Buffer.alloc(4);
  soma.writeUInt32BE(crc32(Buffer.concat([cabecalho, dados])) >>> 0);
  return Buffer.concat([tamanho, cabecalho, dados, soma]);
}

export type Cor = [number, number, number];

export function gerarPng(largura: number, altura: number, pixel: (x: number, y: number) => Cor): Buffer {
  const linha = largura * 3 + 1;
  const bruto = Buffer.alloc(linha * altura);
  for (let y = 0; y < altura; y++) {
    bruto[y * linha] = 0; // sem filtro
    for (let x = 0; x < largura; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * linha + 1 + x * 3;
      bruto[o] = r;
      bruto[o + 1] = g;
      bruto[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(bruto, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

const limitar = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

// ---------------------------------------------------------------------------
// Fotos de demonstração: uma cena de estúdio com a silhueta do item.
// ---------------------------------------------------------------------------
// Tudo é desenhado por distância até formas simples (círculo, anel, caixa
// arredondada, traço), com borda suavizada. Coordenadas: origem no centro da
// imagem, unidade = altura da imagem, y para baixo.

type Tom = 'corpo' | 'escuro' | 'claro' | 'acento';
type Forma =
  | { t: 'circulo'; x: number; y: number; r: number; tom: Tom }
  | { t: 'anel'; x: number; y: number; r: number; e: number; tom: Tom }
  | { t: 'caixa'; x: number; y: number; l: number; a: number; raio?: number; tom: Tom }
  | { t: 'traco'; x1: number; y1: number; x2: number; y2: number; e: number; tom: Tom };

const c = (x: number, y: number, r: number, tom: Tom): Forma => ({ t: 'circulo', x, y, r, tom });
const a = (x: number, y: number, r: number, e: number, tom: Tom): Forma => ({ t: 'anel', x, y, r, e, tom });
const b = (x: number, y: number, l: number, alt: number, raio: number, tom: Tom): Forma => ({ t: 'caixa', x, y, l, a: alt, raio, tom });
const s = (x1: number, y1: number, x2: number, y2: number, e: number, tom: Tom): Forma => ({ t: 'traco', x1, y1, x2, y2, e, tom });

export type Figura = 'camera' | 'bicicleta' | 'carro' | 'violao' | 'poltrona' | 'vinil' | 'relogio' | 'generica';

/** `base` é a altura (y) em que o objeto encosta no chão, para a sombra. */
const FIGURAS: Record<Figura, { base: number; largura: number; formas: Forma[] }> = {
  camera: {
    base: 0.2,
    largura: 0.32,
    formas: [
      b(-0.2, -0.175, 0.045, 0.022, 0.01, 'escuro'),
      b(0, -0.17, 0.1, 0.05, 0.02, 'corpo'),
      b(0, 0.02, 0.3, 0.17, 0.03, 'corpo'),
      b(0, -0.085, 0.3, 0.014, 0, 'acento'),
      b(0, 0.13, 0.3, 0.05, 0.03, 'acento'),
      c(0, 0.03, 0.128, 'escuro'),
      c(0, 0.03, 0.1, 'acento'),
      c(0, 0.03, 0.068, 'escuro'),
      c(-0.028, 0.002, 0.018, 'claro'),
      b(0.21, -0.04, 0.035, 0.022, 0.006, 'escuro'),
    ],
  },
  bicicleta: {
    base: 0.3,
    largura: 0.46,
    formas: [
      a(-0.27, 0.12, 0.17, 0.014, 'escuro'),
      a(0.27, 0.12, 0.17, 0.014, 'escuro'),
      a(-0.27, 0.12, 0.15, 0.004, 'acento'),
      a(0.27, 0.12, 0.15, 0.004, 'acento'),
      s(-0.27, 0.12, -0.06, 0.12, 0.011, 'corpo'),
      s(-0.27, 0.12, -0.12, -0.12, 0.011, 'corpo'),
      s(-0.06, 0.12, -0.12, -0.12, 0.014, 'corpo'),
      s(-0.12, -0.12, 0.16, -0.12, 0.014, 'corpo'),
      s(-0.06, 0.12, 0.16, -0.12, 0.014, 'corpo'),
      s(0.16, -0.12, 0.27, 0.12, 0.012, 'corpo'),
      s(-0.12, -0.12, -0.13, -0.165, 0.01, 'escuro'),
      b(-0.135, -0.172, 0.055, 0.012, 0.01, 'escuro'),
      s(0.16, -0.12, 0.145, -0.2, 0.01, 'escuro'),
      s(0.145, -0.2, 0.225, -0.2, 0.011, 'escuro'),
      c(-0.27, 0.12, 0.02, 'corpo'),
      c(0.27, 0.12, 0.02, 'corpo'),
      c(-0.06, 0.12, 0.032, 'escuro'),
    ],
  },
  carro: {
    base: 0.24,
    largura: 0.46,
    formas: [
      b(-0.02, -0.045, 0.23, 0.075, 0.06, 'corpo'),
      b(0, 0.08, 0.42, 0.075, 0.045, 'corpo'),
      b(-0.115, -0.045, 0.085, 0.045, 0.02, 'escuro'),
      b(0.08, -0.045, 0.085, 0.045, 0.02, 'escuro'),
      b(0, 0.115, 0.42, 0.012, 0, 'acento'),
      c(-0.25, 0.155, 0.085, 'escuro'),
      c(0.25, 0.155, 0.085, 'escuro'),
      c(-0.25, 0.155, 0.04, 'claro'),
      c(0.25, 0.155, 0.04, 'claro'),
      b(0.395, 0.05, 0.02, 0.018, 0.01, 'claro'),
      b(-0.4, 0.05, 0.014, 0.018, 0.008, 'acento'),
      b(-0.03, 0.06, 0.03, 0.006, 0.003, 'escuro'),
    ],
  },
  violao: {
    base: 0.26,
    largura: 0.42,
    formas: [
      s(0.05, 0.02, 0.47, -0.2, 0.026, 'escuro'),
      b(0.5, -0.215, 0.05, 0.035, 0.012, 'escuro'),
      c(-0.17, 0.09, 0.17, 'corpo'),
      c(0.02, 0.015, 0.13, 'corpo'),
      a(-0.02, 0.035, 0.062, 0.006, 'acento'),
      c(-0.02, 0.035, 0.05, 'escuro'),
      s(-0.25, 0.1, -0.2, 0.19, 0.012, 'escuro'),
      s(-0.2, 0.125, 0.5, -0.215, 0.003, 'claro'),
    ],
  },
  poltrona: {
    base: 0.27,
    largura: 0.34,
    formas: [
      s(-0.2, 0.15, -0.225, 0.26, 0.014, 'escuro'),
      s(0.2, 0.15, 0.225, 0.26, 0.014, 'escuro'),
      b(0, -0.08, 0.2, 0.18, 0.07, 'corpo'),
      b(0, -0.1, 0.13, 0.11, 0.05, 'acento'),
      b(0, 0.1, 0.25, 0.065, 0.035, 'corpo'),
      b(0, 0.065, 0.19, 0.035, 0.03, 'acento'),
      b(-0.255, 0.045, 0.055, 0.125, 0.045, 'corpo'),
      b(0.255, 0.045, 0.055, 0.125, 0.045, 'corpo'),
    ],
  },
  vinil: {
    base: 0.3,
    largura: 0.4,
    formas: [
      b(-0.14, 0, 0.27, 0.27, 0.004, 'corpo'),
      b(-0.14, -0.2, 0.27, 0.03, 0, 'acento'),
      c(0.13, 0, 0.26, 'escuro'),
      a(0.13, 0, 0.215, 0.003, 'acento'),
      a(0.13, 0, 0.17, 0.003, 'acento'),
      a(0.13, 0, 0.13, 0.003, 'acento'),
      c(0.13, 0, 0.085, 'claro'),
      c(0.13, 0, 0.012, 'escuro'),
    ],
  },
  relogio: {
    base: 0.44,
    largura: 0.22,
    formas: [
      b(0, 0, 0.078, 0.43, 0.02, 'escuro'),
      b(0, -0.3, 0.078, 0.008, 0, 'acento'),
      b(0, 0.3, 0.078, 0.008, 0, 'acento'),
      b(0.19, 0, 0.022, 0.026, 0.008, 'corpo'),
      c(0, 0, 0.175, 'corpo'),
      c(0, 0, 0.145, 'claro'),
      a(0, 0, 0.125, 0.004, 'acento'),
      s(0, 0, 0, -0.1, 0.008, 'escuro'),
      s(0, 0, 0.07, 0.035, 0.008, 'escuro'),
      c(0, 0, 0.014, 'escuro'),
    ],
  },
  generica: {
    base: 0.24,
    largura: 0.3,
    formas: [b(0, 0.04, 0.24, 0.2, 0.02, 'corpo'), b(0, -0.1, 0.24, 0.012, 0, 'acento'), b(0, 0.04, 0.03, 0.2, 0, 'acento')],
  },
};

/** Distância com sinal até a forma (negativa = dentro). */
function distancia(f: Forma, x: number, y: number): number {
  switch (f.t) {
    case 'circulo':
      return Math.hypot(x - f.x, y - f.y) - f.r;
    case 'anel':
      return Math.abs(Math.hypot(x - f.x, y - f.y) - f.r) - f.e;
    case 'caixa': {
      const r = f.raio ?? 0;
      const dx = Math.abs(x - f.x) - (f.l - r);
      const dy = Math.abs(y - f.y) - (f.a - r);
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
    }
    case 'traco': {
      const vx = f.x2 - f.x1;
      const vy = f.y2 - f.y1;
      const t = Math.max(0, Math.min(1, ((x - f.x1) * vx + (y - f.y1) * vy) / (vx * vx + vy * vy)));
      return Math.hypot(x - (f.x1 + vx * t), y - (f.y1 + vy * t)) - f.e;
    }
  }
}

const mistura = (de: Cor, para: Cor, t: number): Cor => [
  de[0] + (para[0] - de[0]) * t,
  de[1] + (para[1] - de[1]) * t,
  de[2] + (para[2] - de[2]) * t,
];

/**
 * Foto de demonstração: parede e chão de estúdio na cor do item, luz vinda de
 * cima à esquerda, sombra no chão e a silhueta do item. As variações mudam o
 * enquadramento: 0 = inteiro, 1 = aproximado, 2 = espelhado com fundo escuro.
 */
export function fotoDeDemonstracao(
  cor: Cor,
  variacao: number,
  largura = 800,
  altura = 600,
  figura: Figura = 'generica',
): Buffer {
  const cena = FIGURAS[figura];
  const v = variacao % 3;
  const zoom = v === 1 ? 1.45 : 1;
  const desvioX = v === 1 ? 0.06 : 0;
  const desvioY = v === 1 ? 0.03 : 0;
  const espelho = v === 2 ? -1 : 1;
  const fundo: Cor = v === 2 ? mistura(cor, [18, 18, 22], 0.62) : cor;

  const branco: Cor = [255, 255, 255];
  const preto: Cor = [14, 14, 18];
  const tons: Record<Tom, Cor> = {
    corpo: mistura(fundo, [250, 247, 240], 0.9),
    claro: [255, 255, 255],
    acento: mistura(cor, branco, v === 2 ? 0.35 : 0.55),
    escuro: mistura(cor, preto, 0.82),
  };
  const horizonte = (cena.base - desvioY) / zoom + 0.02; // onde a parede vira chão
  const px = 1 / altura;

  return gerarPng(largura, altura, (ix, iy) => {
    const x = (ix + 0.5 - largura / 2) / altura;
    const y = (iy + 0.5) / altura - 0.5;

    // parede: mais clara no alto, com um foco de luz atrás do objeto
    const foco = Math.max(0, 1 - Math.hypot(x + 0.05, y + 0.08) / 0.75);
    let p = mistura(fundo, branco, 0.1 + 0.3 * foco * foco);
    p = mistura(p, preto, 0.1 + 0.22 * Math.max(0, y + 0.5));
    // chão: um pouco mais escuro, com a linha do horizonte suave
    const chao = Math.max(0, Math.min(1, (y - horizonte) / 0.012));
    p = mistura(p, mistura(fundo, preto, 0.38), chao * 0.75);
    // vinheta
    p = mistura(p, preto, Math.min(0.45, Math.pow(Math.hypot(x / 0.95, y / 0.72), 3) * 0.35));

    // coordenadas no espaço do objeto
    const ox = ((x * espelho) / zoom) + desvioX;
    const oy = y / zoom + desvioY;

    // sombra no chão, embaixo do objeto
    const sombra = Math.hypot((ox + 0.02) / (cena.largura * 1.15), (oy - cena.base - 0.012) / 0.03);
    if (sombra < 1) p = mistura(p, preto, 0.5 * (1 - sombra) ** 1.5);

    for (const forma of cena.formas) {
      const d = distancia(forma, ox, oy) * zoom;
      if (d > px) continue;
      const cobertura = Math.max(0, Math.min(1, 0.5 - d / px));
      // luz de cima à esquerda: o tom escurece para baixo e para a direita
      const meioX = forma.t === 'traco' ? (forma.x1 + forma.x2) / 2 : forma.x;
      const meioY = forma.t === 'traco' ? (forma.y1 + forma.y2) / 2 : forma.y;
      const luz = Math.max(-0.5, Math.min(0.5, (oy - meioY) * 1.1 + (ox - meioX) * 0.35));
      let tinta = tons[forma.tom];
      tinta = luz > 0 ? mistura(tinta, preto, luz * 0.5) : mistura(tinta, branco, -luz * 0.35);
      // contorno interno discreto, para as peças não se fundirem
      if (d > -2.2 * px) tinta = mistura(tinta, preto, 0.18);
      p = mistura(p, tinta, cobertura);
    }

    // grão leve para não parecer vetor chapado
    const grao = (((ix * 73856093) ^ (iy * 19349663)) >>> 0) % 7;
    return [limitar(p[0] + grao - 3), limitar(p[1] + grao - 3), limitar(p[2] + grao - 3)];
  });
}
