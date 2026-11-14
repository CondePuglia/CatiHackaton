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

/** Foto de demonstração: degradê na cor do item com uma forma clara, diferente a cada variação. */
export function fotoDeDemonstracao(cor: Cor, variacao: number, largura = 640, altura = 480): Buffer {
  const cx = largura * (0.3 + 0.2 * (variacao % 3));
  const cy = altura * (0.35 + 0.15 * ((variacao + 1) % 3));
  const raio = Math.min(largura, altura) * (0.22 + 0.05 * (variacao % 2));
  return gerarPng(largura, altura, (x, y) => {
    const t = (x / largura) * 0.6 + (y / altura) * 0.4;
    const base: Cor = [cor[0] * (1 - t * 0.55), cor[1] * (1 - t * 0.55), cor[2] * (1 - t * 0.55)];
    const d = Math.hypot(x - cx, y - cy);
    if (d < raio) {
      const brilho = 1 - d / raio;
      return [
        limitar(base[0] + (255 - base[0]) * (0.35 + 0.45 * brilho)),
        limitar(base[1] + (255 - base[1]) * (0.35 + 0.45 * brilho)),
        limitar(base[2] + (255 - base[2]) * (0.35 + 0.45 * brilho)),
      ];
    }
    return [limitar(base[0]), limitar(base[1]), limitar(base[2])];
  });
}
