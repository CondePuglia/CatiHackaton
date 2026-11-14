import { hash } from '@node-rs/argon2';
import { aguardarArmazenamento, salvarObjeto } from './armazenamento.js';
import { config } from './config.js';
import { aguardarBanco, pool, transacao } from './db.js';
import { migrar } from './migrar.js';
import { fotoDeDemonstracao, type Cor } from './png.js';

/**
 * RNF04 — dados de demonstração: 1 comitente, 3 compradores e um leilão em cada
 * estado. Os horários são relativos ao momento em que o comando roda.
 *
 *   docker compose run --rm api node dist/seed.js            # cria (não repete se já existir)
 *   docker compose run --rm api node dist/seed.js --recriar  # APAGA TUDO e cria de novo
 */
export const SENHA_DEMO = 'demo1234';
const CONTAS = [
  { nome: 'Carla Comitente', email: 'carla@demo.dev' },
  { nome: 'Ana Compradora', email: 'ana@demo.dev' },
  { nome: 'Bruno Comprador', email: 'bruno@demo.dev' },
  { nome: 'Caio Comprador', email: 'caio@demo.dev' },
];

type Lance = { quem: number; valor: number };
type Modelo = {
  nome: string;
  descricao: string;
  categoria: string;
  cor: Cor;
  preco: number;
  status: 'AGENDADO' | 'EM_ANDAMENTO' | 'VENDIDO' | 'ENCERRADO_SEM_LANCES' | 'CANCELADO';
  /** minutos em relação a agora */
  inicio: number;
  termino: number;
  lances?: Lance[];
};

// quem: índice em CONTAS (1 = Ana, 2 = Bruno, 3 = Caio)
const LEILOES: Modelo[] = [
  {
    nome: 'Violão clássico de luthier',
    descricao: 'Violão de cedro maciço, feito à mão em 2019. Acompanha estojo rígido.',
    categoria: 'arte', cor: [180, 110, 60], preco: 1_200_00, status: 'AGENDADO', inicio: 10, termino: 40,
  },
  {
    nome: 'Bicicleta de estrada aro 700',
    descricao: 'Quadro de alumínio tamanho 54, grupo de 22 marchas, revisada este mês.',
    categoria: 'esportes', cor: [40, 140, 200], preco: 800_00, status: 'EM_ANDAMENTO', inicio: -5, termino: 25,
  },
  {
    nome: 'Câmera analógica anos 70',
    descricao: 'Câmera reflex 35 mm funcionando, com lente 50 mm e estojo de couro original.',
    categoria: 'eletronicos', cor: [90, 90, 110], preco: 300_00, status: 'EM_ANDAMENTO', inicio: -10, termino: 15,
    lances: [{ quem: 1, valor: 300_00 }, { quem: 2, valor: 320_00 }, { quem: 1, valor: 350_00 }],
  },
  {
    nome: 'Poltrona de couro restaurada',
    descricao: 'Poltrona dos anos 60 com couro legítimo restaurado e estrutura em jacarandá.',
    categoria: 'casa', cor: [130, 70, 50], preco: 500_00, status: 'VENDIDO', inicio: -180, termino: -120,
    lances: [{ quem: 2, valor: 500_00 }, { quem: 3, valor: 560_00 }, { quem: 2, valor: 600_00 }, { quem: 3, valor: 650_00 }],
  },
  {
    nome: 'Coleção de vinis de MPB',
    descricao: 'Trinta discos de vinil de MPB dos anos 70 e 80, todos com capa e encarte.',
    categoria: 'arte', cor: [150, 60, 150], preco: 400_00, status: 'ENCERRADO_SEM_LANCES', inicio: -300, termino: -240,
  },
  {
    nome: 'Relógio de pulso automático',
    descricao: 'Relógio automático com caixa de aço de 40 mm e pulseira de couro. Com caixa e manual.',
    categoria: 'moda', cor: [60, 150, 110], preco: 900_00, status: 'CANCELADO', inicio: 120, termino: 180,
  },
];

async function principal(): Promise<void> {
  const recriar = process.argv.includes('--recriar');
  await aguardarBanco();
  await migrar();
  await aguardarArmazenamento();

  if (recriar) {
    await pool.query(
      `TRUNCATE usuarios, sessoes, itens, fotos, leiloes, lances, apelidos, tentativas_lance RESTART IDENTITY CASCADE`,
    );
  } else {
    const { rowCount } = await pool.query('SELECT 1 FROM usuarios WHERE lower(email) = $1', [CONTAS[0].email]);
    if (rowCount) {
      console.log('Dados de demonstração já existem. Use --recriar para apagar tudo e criar de novo.');
      return;
    }
  }

  const senhaHash = await hash(SENHA_DEMO);
  const ids: number[] = [];
  for (const [i, conta] of CONTAS.entries()) {
    // a primeira compradora ganha uma conta "antiga", útil para regras que dependem da idade da conta
    const idade = i === 1 ? 400 : 0;
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, criado_em)
       VALUES ($1, $2, $3, clock_timestamp() - make_interval(days => $4)) RETURNING id`,
      [conta.nome, conta.email, senhaHash, idade],
    );
    ids.push(rows[0].id);
  }
  const comitente = ids[0];

  for (const [n, m] of LEILOES.entries()) {
    // as fotos vão para o bucket antes da transação do banco
    const chaves: string[] = [];
    for (let v = 0; v < 3; v++) {
      const chave = `${config.armazenamento.prefixo}/demo-${Date.now()}-${n}-${v}.png`;
      const dados = fotoDeDemonstracao(m.cor, v);
      await salvarObjeto(chave, dados, 'image/png');
      chaves.push(`${chave}|${dados.length}`);
    }

    await transacao(async (c) => {
      const item = await c.query(
        `INSERT INTO itens (comitente_id, nome, descricao, categoria) VALUES ($1, $2, $3, $4) RETURNING id`,
        [comitente, m.nome, m.descricao, m.categoria],
      );
      const itemId = item.rows[0].id;
      for (const [ordem, bruto] of chaves.entries()) {
        const [chave, tamanho] = bruto.split('|');
        await c.query(
          `INSERT INTO fotos (dono_id, item_id, ordem, chave, tipo, tamanho_bytes) VALUES ($1, $2, $3, $4, 'image/png', $5)`,
          [comitente, itemId, ordem + 1, chave, Number(tamanho)],
        );
      }

      const lances = m.lances ?? [];
      const ultimo = lances[lances.length - 1];
      const final = m.status !== 'AGENDADO' && m.status !== 'EM_ANDAMENTO';
      const leilao = await c.query(
        `INSERT INTO leiloes (item_id, comitente_id, status, preco_inicial_centavos,
                              inicio_em, termino_original_em, termino_em,
                              preco_atual_centavos, lider_id, total_lances, versao, aberto_em, encerrado_em)
         VALUES ($1, $2, $3, $4,
                 clock_timestamp() + make_interval(mins => $5),
                 clock_timestamp() + make_interval(mins => $6),
                 clock_timestamp() + make_interval(mins => $6),
                 $7, $8, $9, $10,
                 CASE WHEN $11 THEN clock_timestamp() + make_interval(mins => $5) END,
                 CASE WHEN $12 THEN clock_timestamp() + make_interval(mins => LEAST($6, 0)) END)
         RETURNING id, inicio_em`,
        [
          itemId, comitente, m.status, m.preco, m.inicio, m.termino,
          ultimo?.valor ?? null, ultimo ? ids[ultimo.quem] : null, lances.length, lances.length + 1,
          m.status !== 'AGENDADO' && m.status !== 'CANCELADO', final,
        ],
      );
      const leilaoId = leilao.rows[0].id;

      const numeros = new Map<number, number>();
      for (const [i, l] of lances.entries()) {
        if (!numeros.has(l.quem)) {
          numeros.set(l.quem, numeros.size + 1);
          await c.query('INSERT INTO apelidos (leilao_id, usuario_id, numero) VALUES ($1, $2, $3)', [
            leilaoId, ids[l.quem], numeros.get(l.quem),
          ]);
        }
        await c.query(
          `INSERT INTO lances (leilao_id, usuario_id, valor_centavos, sequencia, criado_em)
           VALUES ($1, $2, $3, $4, $5::timestamptz + make_interval(secs => $6))`,
          [leilaoId, ids[l.quem], l.valor, i + 1, leilao.rows[0].inicio_em, (i + 1) * 45],
        );
      }
    });
  }

  console.log(`Dados de demonstração criados: ${CONTAS.length} contas e ${LEILOES.length} leilões.`);
  console.log(`Senha de todas as contas: ${SENHA_DEMO}`);
  for (const conta of CONTAS) console.log(`  ${conta.email}  (${conta.nome})`);
}

principal()
  .catch((erro) => {
    console.error('[seed] falhou:', erro);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
