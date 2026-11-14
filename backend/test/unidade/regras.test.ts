import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectarImagem } from '../../src/fotos.js';
import { duracaoLegivel, reais } from '../../src/leiloes.js';
import { gerarPng } from '../../src/png.js';
import { apelido, incremento, lanceMinimo, novoTermino, podeCancelar, pontuacao } from '../../src/regras.js';

test('RF14: o incremento segue a tabela de referência nas duas bordas de cada faixa', () => {
  const casos: Array<[number, number]> = [
    [1_00, 1_00],
    [99_99, 1_00],
    [100_00, 5_00],
    [499_99, 5_00],
    [500_00, 10_00],
    [999_99, 10_00],
    [1_000_00, 50_00],
    [4_999_99, 50_00],
    [5_000_00, 100_00],
    [24_999_99, 100_00],
    [25_000_00, 500_00],
    [9_999_999_00, 500_00],
  ];
  for (const [preco, esperado] of casos) {
    assert.equal(incremento(preco), esperado, `preço atual ${preco}`);
  }
});

test('RF14: o primeiro lance pode ser igual ao preço inicial', () => {
  assert.equal(lanceMinimo({ totalLances: 0, precoInicialCentavos: 150_00, precoAtualCentavos: null }), 150_00);
});

test('RF14: depois de um lance, o mínimo é preço atual + incremento, e sempre cresce', () => {
  let preco = 90_00;
  let total = 1;
  let anterior = 0;
  for (let i = 0; i < 400; i++) {
    const minimo = lanceMinimo({ totalLances: total, precoInicialCentavos: 90_00, precoAtualCentavos: preco });
    assert.equal(minimo, preco + incremento(preco));
    assert.ok(minimo > preco, 'o mínimo é sempre maior que o preço atual');
    assert.ok(minimo > anterior, 'o mínimo cresce a cada lance aceito');
    anterior = minimo;
    preco = minimo;
    total++;
  }
});

test('RF14: mesmo estado, mesmo resultado (função pura)', () => {
  const estado = { totalLances: 7, precoInicialCentavos: 100_00, precoAtualCentavos: 1_234_56 };
  assert.equal(lanceMinimo(estado), lanceMinimo({ ...estado }));
  assert.equal(lanceMinimo(estado), 1_234_56 + 50_00);
});

const regra = { janelaSegundos: 120, maximoSegundos: 1800 };
const t = (segundos: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, 0) + segundos * 1000);

test('RF15: lance com mais tempo que a janela não mexe no término', () => {
  assert.deepEqual(novoTermino(t(0), t(120), t(120), regra), t(120));
  assert.deepEqual(novoTermino(t(0), t(500), t(500), regra), t(500));
});

test('RF15: lance dentro da janela leva o término para janela depois do lance', () => {
  assert.deepEqual(novoTermino(t(100), t(119), t(119), regra), t(220));
  assert.deepEqual(novoTermino(t(118.5), t(119), t(119), regra), t(238.5));
});

test('RF15: a prorrogação acumulada nunca passa do máximo', () => {
  const original = t(0);
  const teto = t(1800);
  // já prorrogado até 10 s antes do teto: só ganha os 10 s que faltam
  assert.deepEqual(novoTermino(t(1785), t(1790), original, regra), teto);
  // no teto, não prorroga mais
  assert.deepEqual(novoTermino(t(1799), teto, original, regra), teto);
});

test('RF15: o término nunca recua', () => {
  const original = t(0);
  for (let agora = 0; agora < 1800; agora += 7) {
    const atual = t(Math.max(60, agora + 1));
    const novo = novoTermino(t(agora), atual, original, regra);
    assert.ok(novo.getTime() >= atual.getTime());
    assert.ok(novo.getTime() <= t(1800).getTime() || novo.getTime() === atual.getTime());
  }
});

test('RF08: cancelamento só enquanto agendado, ou em andamento sem lances e antes do término', () => {
  const base = { inicioEm: t(0), terminoEm: t(100) };
  assert.equal(podeCancelar({ ...base, status: 'AGENDADO', totalLances: 0 }, t(-10)), true);
  assert.equal(podeCancelar({ ...base, status: 'EM_ANDAMENTO', totalLances: 0 }, t(50)), true);
  assert.equal(podeCancelar({ ...base, status: 'EM_ANDAMENTO', totalLances: 1 }, t(50)), false);
  assert.equal(podeCancelar({ ...base, status: 'EM_ANDAMENTO', totalLances: 0 }, t(100)), false);
  for (const status of ['VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO'] as const) {
    assert.equal(podeCancelar({ ...base, status, totalLances: 0 }, t(50)), false);
  }
});

test('RF09: o apelido não carrega dado pessoal', () => {
  assert.equal(apelido(3), 'Participante 3');
});

test('RF07: o tipo da foto é decidido pelo conteúdo', () => {
  assert.deepEqual(detectarImagem(gerarPng(2, 2, () => [1, 2, 3])), { mime: 'image/png', extensao: 'png' });
  assert.deepEqual(detectarImagem(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), {
    mime: 'image/jpeg',
    extensao: 'jpg',
  });
  assert.deepEqual(detectarImagem(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), {
    mime: 'image/webp',
    extensao: 'webp',
  });
  assert.equal(detectarImagem(Buffer.from('isto não é uma imagem')), null);
  assert.equal(detectarImagem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(detectarImagem(Buffer.from('GIF89a')), null);
  assert.equal(detectarImagem(Buffer.alloc(0)), null);
});

test('RF19: dinheiro é formatado a partir de centavos inteiros', () => {
  assert.equal(reais(1), 'R$ 0,01');
  assert.equal(reais(123_456_78), 'R$ 123.456,78');
  assert.equal(reais(10 + 20), 'R$ 0,30'); // 0.1 + 0.2 em ponto flutuante daria 0,30000000000000004
});

test('mensagens de prazo ficam legíveis', () => {
  assert.equal(duracaoLegivel(30), '30 segundos');
  assert.equal(duracaoLegivel(60), '1 minuto');
  assert.equal(duracaoLegivel(7200), '2 horas');
  assert.equal(duracaoLegivel(604800), '7 dias');
  assert.equal(duracaoLegivel(90), '90 segundos');
});

test('RF29: pontuação fica entre 0 e 100, com os tetos de cada parcela', () => {
  const zero = { rendaCentavos: 0, diasDeConta: 0, compras: 0, totalCompradoCentavos: 0 };
  assert.equal(pontuacao(zero), 0);

  // teto de renda: R$ 10.000 = 1.000.000 centavos
  assert.equal(pontuacao({ ...zero, rendaCentavos: 1_000_000 }), 50);
  // teto de idade: 180 dias
  assert.equal(pontuacao({ ...zero, diasDeConta: 180 }), 20);
  // teto de compras: 10 compras
  assert.equal(pontuacao({ ...zero, compras: 10 }), 15);
  // teto de valor: R$ 20.000 = 2.000.000 centavos
  assert.equal(pontuacao({ ...zero, totalCompradoCentavos: 2_000_000 }), 15);

  // tudo no teto: 100
  assert.equal(
    pontuacao({ rendaCentavos: 10_000_000, diasDeConta: 365, compras: 10, totalCompradoCentavos: 2_000_000 }),
    100,
  );

  // passar do teto não passa de 100
  assert.equal(
    pontuacao({ rendaCentavos: 999_999_999, diasDeConta: 9999, compras: 999, totalCompradoCentavos: 999_999_999 }),
    100,
  );
});

test('RF29: as parcelas são proporcionais e arredondadas só no fim', () => {
  // renda de R$ 5.000 (500.000 centavos) = metade do teto -> 25
  assert.equal(pontuacao({ rendaCentavos: 500_000, diasDeConta: 0, compras: 0, totalCompradoCentavos: 0 }), 25);
  // 90 dias = metade do teto -> 10
  assert.equal(pontuacao({ rendaCentavos: 0, diasDeConta: 90, compras: 0, totalCompradoCentavos: 0 }), 10);
  // 5 compras = metade do teto -> 7.5
  assert.equal(pontuacao({ rendaCentavos: 0, diasDeConta: 0, compras: 5, totalCompradoCentavos: 0 }), 8);
  // total de R$ 10.000 (1.000.000 centavos) = metade do teto -> 7.5
  assert.equal(pontuacao({ rendaCentavos: 0, diasDeConta: 0, compras: 0, totalCompradoCentavos: 1_000_000 }), 8);

  // soma exata em centavos: 25 + 10 + 7.5 + 7.5 = 50
  assert.equal(
    pontuacao({ rendaCentavos: 500_000, diasDeConta: 90, compras: 5, totalCompradoCentavos: 1_000_000 }),
    50,
  );
});
