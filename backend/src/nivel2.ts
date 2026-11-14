import { config } from './config.js';
import { agoraDoBanco, pool, transacao, violouUnicidade } from './db.js';
import { ErroApp, conflito, naoEncontrado, proibido } from './erros.js';
import { publicar } from './eventos.js';
import {
  anexarFotos,
  inserirLeilao,
  listarLeiloes,
  reservarFotos,
  validarItem,
  validarVenda,
} from './leiloes.js';
import { STATUS_ATIVOS, STATUS_FINAIS, modoDeEdicao } from './regras.js';
import type { Usuario } from './sessoes.js';
import { Validador, objeto } from './validacao.js';

const iso = (d: Date): string => new Date(d).toISOString();

/**
 * RF23 — edição pelo comitente, conforme a tabela do documento:
 *   Agendado, faltando mais que o bloqueio  -> todos os campos
 *   Agendado, dentro do bloqueio            -> nada
 *   Em andamento (com ou sem lances)        -> só acrescentar texto à descrição
 *   Estados finais                          -> nada
 * A linha do leilão é travada antes de decidir, então a edição nunca cruza com
 * a abertura nem com um lance.
 */
export async function editarLeilao(usuario: Usuario, leilaoId: number, corpo: unknown): Promise<void> {
  const dados = objeto(corpo);
  await transacao(async (c) => {
    const { rows } = await c.query(
      `SELECT l.item_id, l.comitente_id, l.status, l.total_lances, l.inicio_em, l.termino_em, i.descricao
         FROM leiloes l JOIN itens i ON i.id = l.item_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [leilaoId],
    );
    const l = rows[0];
    if (!l) throw naoEncontrado('Leilão');
    if (l.comitente_id !== usuario.id) throw proibido('Só o comitente pode editar este leilão.');

    const agora = await agoraDoBanco(c);
    const modo = modoDeEdicao(
      { status: l.status, totalLances: l.total_lances, inicioEm: l.inicio_em, terminoEm: l.termino_em },
      agora,
      config.edicao.bloqueioSegundos,
    );
    if (modo === 'NADA') {
      throw conflito('EDICAO_NAO_PERMITIDA', 'Este leilão não pode mais ser editado.');
    }

    if (modo === 'ACRESCENTAR_DESCRICAO') {
      const v = new Validador();
      const acrescimo = v.texto(dados.acrescimoDescricao, 'acrescimoDescricao', { min: 1, max: config.limites.descricao.max }, 'o complemento');
      const nova = `${l.descricao}\n\n${acrescimo}`;
      if ([...nova].length > config.limites.descricao.max) {
        v.erro('acrescimoDescricao', `A descrição completa passaria de ${config.limites.descricao.max} caracteres.`);
      }
      v.verificar();
      await c.query('UPDATE itens SET descricao = $2 WHERE id = $1', [l.item_id, nova]);
    } else {
      const v = new Validador();
      const item = validarItem(dados, v);
      const venda = validarVenda(dados, v, agora);
      v.verificar();
      await reservarFotos(c, usuario.id, item.fotoIds, l.item_id);
      await c.query('UPDATE itens SET nome = $2, descricao = $3, categoria = $4 WHERE id = $1', [
        l.item_id, item.nome, item.descricao, item.categoria,
      ]);
      await anexarFotos(c, l.item_id, item.fotoIds);
      const termino = new Date(venda.inicioEm.getTime() + venda.duracaoSegundos * 1000);
      await c.query(
        `UPDATE leiloes SET preco_inicial_centavos = $2, inicio_em = $3, termino_original_em = $4, termino_em = $4
          WHERE id = $1`,
        [leilaoId, venda.precoInicialCentavos, venda.inicioEm, termino],
      );
    }
    await c.query('UPDATE leiloes SET versao = versao + 1 WHERE id = $1', [leilaoId]);
    await publicar(c, { leilaoId, tipo: 'EDITADO' });
  });
}

/**
 * RF28 — relistagem: novo leilão para o MESMO item, com todos os campos
 * editáveis. Só a partir de Encerrado sem lances ou Cancelado. O índice único
 * parcial garante que o item nunca tenha dois leilões ativos.
 */
export async function relistarLeilao(usuario: Usuario, leilaoId: number, corpo: unknown): Promise<number> {
  const dados = objeto(corpo);
  const agora = await agoraDoBanco();
  const v = new Validador();
  const item = validarItem(dados, v);
  const venda = validarVenda(dados, v, agora);
  v.verificar();

  try {
    return await transacao(async (c) => {
      const { rows } = await c.query('SELECT item_id, comitente_id, status FROM leiloes WHERE id = $1 FOR UPDATE', [leilaoId]);
      const l = rows[0];
      if (!l) throw naoEncontrado('Leilão');
      if (l.comitente_id !== usuario.id) throw proibido('Só o comitente pode relistar este item.');
      if (l.status !== 'ENCERRADO_SEM_LANCES' && l.status !== 'CANCELADO') {
        throw conflito('RELISTAGEM_NAO_PERMITIDA', 'Só dá para relistar um leilão encerrado sem lances ou cancelado.');
      }
      await reservarFotos(c, usuario.id, item.fotoIds, l.item_id);
      await c.query('UPDATE itens SET nome = $2, descricao = $3, categoria = $4 WHERE id = $1', [
        l.item_id, item.nome, item.descricao, item.categoria,
      ]);
      await anexarFotos(c, l.item_id, item.fotoIds);
      return inserirLeilao(c, l.item_id, usuario.id, venda);
    });
  } catch (erro) {
    if (violouUnicidade(erro, 'leiloes_um_ativo_por_item')) {
      throw new ErroApp(409, 'ITEM_JA_TEM_LEILAO_ATIVO', 'Este item já tem um leilão agendado ou em andamento.');
    }
    throw erro;
  }
}

/** RF27 — leilões em que dei lance e como estou em cada um. */
export async function minhasParticipacoes(usuario: Usuario) {
  const { rows } = await pool.query(
    `SELECT l.id, l.status, l.preco_atual_centavos, l.total_lances, l.termino_em, l.encerrado_em,
            (l.lider_id = $1) AS lidero, i.nome,
            (SELECT f.id FROM fotos f WHERE f.item_id = i.id ORDER BY f.ordem, f.id LIMIT 1) AS foto_id,
            m.maior, m.quantidade, m.ultimo_em
       FROM (SELECT leilao_id, max(valor_centavos) AS maior, count(*) AS quantidade, max(criado_em) AS ultimo_em
               FROM lances WHERE usuario_id = $1 GROUP BY leilao_id) m
       JOIN leiloes l ON l.id = m.leilao_id
       JOIN itens i ON i.id = l.item_id
      ORDER BY (l.status = 'EM_ANDAMENTO') DESC, m.ultimo_em DESC`,
    [usuario.id],
  );
  return {
    participacoes: rows.map((r) => ({
      leilaoId: r.id as number,
      status: r.status as string,
      item: { nome: r.nome as string, fotoUrl: r.foto_id ? `/api/fotos/${r.foto_id}` : null },
      // LIDER e SUPERADO valem com o leilão em andamento; VENCEDOR e NAO_VENCEU, depois de vendido
      situacao: r.status === 'VENDIDO' ? (r.lidero ? 'VENCEDOR' : 'NAO_VENCEU') : r.lidero ? 'LIDER' : 'SUPERADO',
      meuMaiorLanceCentavos: r.maior as number,
      meusLances: r.quantidade as number,
      precoAtualCentavos: r.preco_atual_centavos as number,
      totalLances: r.total_lances as number,
      terminoEm: iso(r.termino_em),
      encerradoEm: r.encerrado_em ? iso(r.encerrado_em) : null,
    })),
    agora: iso(await agoraDoBanco()),
  };
}

/** RF22 — busca de comitentes pelo nome de exibição. Comitente é quem já anunciou algo. */
export async function buscarComitentes(q: string | undefined) {
  const termo = (q ?? '').normalize('NFC').trim();
  const { rows } = await pool.query(
    `SELECT u.id, u.nome, u.criado_em, count(l.id) AS leiloes
       FROM usuarios u JOIN leiloes l ON l.comitente_id = u.id
      WHERE unaccent(u.nome) ILIKE unaccent($1)
      GROUP BY u.id ORDER BY u.nome LIMIT 50`,
    [`%${termo.replace(/[\\%_]/g, '\\$&')}%`],
  );
  return {
    comitentes: rows.map((r) => ({ id: r.id as number, nome: r.nome as string, desde: iso(r.criado_em), leiloes: r.leiloes as number })),
  };
}

/** RF22 — perfil público: nome, data de entrada e leilões. Sem e-mail, sem avaliação. */
export async function perfilDoComitente(id: number, pagina: number) {
  const { rows } = await pool.query('SELECT id, nome, criado_em FROM usuarios WHERE id = $1', [id]);
  if (!rows[0]) throw naoEncontrado('Comitente');
  const [agendados, emAndamento, passados] = await Promise.all([
    listarLeiloes({ comitenteId: id, status: ['AGENDADO'], pagina: 1 }),
    listarLeiloes({ comitenteId: id, status: ['EM_ANDAMENTO'], pagina: 1 }),
    listarLeiloes({ comitenteId: id, status: [...STATUS_FINAIS], pagina }),
  ]);
  return {
    comitente: { id: rows[0].id as number, nome: rows[0].nome as string, desde: iso(rows[0].criado_em) },
    agendados: agendados.leiloes,
    emAndamento: emAndamento.leiloes,
    passados: { leiloes: passados.leiloes, pagina: passados.pagina, porPagina: passados.porPagina, total: passados.total },
    agora: passados.agora,
  };
}

export { STATUS_ATIVOS };
