import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { CATEGORIAS, config } from './config.js';
import { agoraDoBanco } from './db.js';
import { ErroApp, naoAutenticado, naoEncontrado } from './erros.js';
import { abrirFoto, enviarFoto } from './fotos.js';
import { cancelarLeilao, criarLeilao, detalharLeilao, listarLeiloes } from './leiloes.js';
import { buscarComitentes, editarLeilao, minhasParticipacoes, perfilDoComitente, relistarLeilao } from './nivel2.js';
import { FAIXAS_INCREMENTO, STATUS, type Status } from './regras.js';
import { criarSessao, encerrarSessao, usarSessao, type Usuario } from './sessoes.js';
import { autenticar, cadastrar, usuarioPublico } from './usuarios.js';
import { idPositivo } from './validacao.js';

function lerStatus(bruto: unknown): Status[] | undefined {
  if (typeof bruto !== 'string' || bruto.trim() === '') return undefined;
  if (bruto.trim().toUpperCase() === 'TODOS') return [...STATUS];
  const lista = bruto
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (lista.some((s) => !STATUS.includes(s as Status))) {
    throw new ErroApp(422, 'VALIDACAO', 'Filtro de estado inválido.', {
      status: `Estados aceitos: ${STATUS.join(', ')} ou TODOS.`,
    });
  }
  return lista as Status[];
}

function lerPagina(bruto: unknown): number {
  const n = typeof bruto === 'string' ? Number(bruto) : 1;
  return Number.isSafeInteger(n) && n >= 1 && n <= 100000 ? n : 1;
}

function lerId(bruto: unknown, oQue: string): number {
  const id = idPositivo(bruto);
  if (id === null) throw naoEncontrado(oQue);
  return id;
}

export async function criarApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.limites.fotos.tamanhoMaxBytes, files: 1, fields: 4 },
  });

  // -------------------------------------------------------------------------
  // Erros: sempre { erro: { codigo, mensagem, campos? } }
  // -------------------------------------------------------------------------
  app.setErrorHandler((erro: unknown, req, reply) => {
    if (erro instanceof ErroApp) {
      return reply.status(erro.status).send({
        erro: { codigo: erro.codigo, mensagem: erro.message, ...(erro.campos ? { campos: erro.campos } : {}) },
      });
    }
    const e = erro as { statusCode?: number; code?: string };
    if (e?.code === 'FST_REQ_FILE_TOO_LARGE') {
      const mb = Math.floor(config.limites.fotos.tamanhoMaxBytes / 1024 / 1024);
      return reply.status(413).send({
        erro: { codigo: 'ARQUIVO_GRANDE', mensagem: `Cada foto pode ter no máximo ${mb} MB.` },
      });
    }
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error(erro);
      return reply.status(500).send({
        erro: { codigo: 'ERRO_INTERNO', mensagem: 'Algo deu errado do nosso lado. Tente de novo.' },
      });
    }
    return reply.status(status).send({
      erro: { codigo: 'REQUISICAO_INVALIDA', mensagem: 'Requisição inválida.' },
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'Rota não encontrada.' } }),
  );

  // -------------------------------------------------------------------------
  // Sessão (RF02): toda rota protegida passa por `exigirLogin`
  // -------------------------------------------------------------------------
  const tokenDe = (req: FastifyRequest): string | undefined => req.cookies[config.sessao.cookie];
  const usuarioDe = (req: FastifyRequest): Promise<Usuario | null> => usarSessao(tokenDe(req));
  const exigirLogin = async (req: FastifyRequest): Promise<Usuario> => {
    const usuario = await usuarioDe(req);
    if (!usuario) throw naoAutenticado();
    return usuario;
  };

  const gravarCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(config.sessao.cookie, token, {
      path: '/',
      httpOnly: true, // JavaScript da página não lê o token
      sameSite: 'lax', // não acompanha POST vindo de outro site
      secure: config.sessao.cookieSeguro,
      maxAge: config.sessao.maximoSegundos,
    });

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------
  app.get('/api/saude', async () => ({ ok: true, agora: (await agoraDoBanco()).toISOString() }));

  /** Tudo o que a tela precisa para montar formulários sem repetir regra. */
  app.get('/api/config', async () => ({
    agora: (await agoraDoBanco()).toISOString(),
    categorias: CATEGORIAS,
    limites: {
      nomeItem: config.limites.nomeItem,
      descricao: config.limites.descricao,
      fotos: config.limites.fotos,
      precoInicialCentavos: config.limites.precoInicialCentavos,
      antecedenciaSegundos: config.limites.antecedenciaSegundos,
      duracaoSegundos: config.limites.duracaoSegundos,
      nomeUsuario: config.limites.nomeUsuario,
      senha: { min: config.limites.senha.min },
    },
    prorrogacao: config.prorrogacao,
    incrementos: FAIXAS_INCREMENTO,
    lances: config.lances,
    edicao: config.edicao,
    sessao: {
      inatividadeSegundos: config.sessao.inatividadeSegundos,
      maximoSegundos: config.sessao.maximoSegundos,
    },
  }));

  // -------------------------------------------------------------------------
  // Contas (RF01–RF03)
  // -------------------------------------------------------------------------
  app.post('/api/usuarios', async (req, reply) => {
    const usuario = await cadastrar(req.body);
    gravarCookie(reply, await criarSessao(usuario.id));
    return reply.status(201).send({ usuario: usuarioPublico(usuario) });
  });

  app.post('/api/sessao', async (req, reply) => {
    const usuario = await autenticar(req.body);
    gravarCookie(reply, await criarSessao(usuario.id));
    return reply.send({ usuario: usuarioPublico(usuario) });
  });

  app.delete('/api/sessao', async (req, reply) => {
    await encerrarSessao(tokenDe(req));
    reply.clearCookie(config.sessao.cookie, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/eu', async (req) => ({ usuario: usuarioPublico(await exigirLogin(req)) }));

  // -------------------------------------------------------------------------
  // Fotos (RF07)
  // -------------------------------------------------------------------------
  app.post('/api/fotos', async (req, reply) => {
    const usuario = await exigirLogin(req);
    if (!req.isMultipart()) {
      throw new ErroApp(400, 'ARQUIVO_AUSENTE', 'Envie a foto como multipart/form-data, no campo "arquivo".');
    }
    const arquivo = await req.file();
    if (!arquivo) {
      throw new ErroApp(400, 'ARQUIVO_AUSENTE', 'Envie a foto no campo "arquivo".');
    }
    const dados = await arquivo.toBuffer(); // estoura com 413 acima do limite
    const foto = await enviarFoto(usuario, dados);
    return reply.status(201).send({ foto });
  });

  app.get('/api/fotos/:id', async (req, reply) => {
    const id = lerId((req.params as { id: string }).id, 'Foto');
    const foto = await abrirFoto(id);
    reply
      .header('content-type', foto.tipo)
      .header('x-content-type-options', 'nosniff')
      // a chave nunca muda de conteúdo, então o navegador pode guardar para sempre
      .header('cache-control', 'public, max-age=31536000, immutable');
    if (foto.tamanho !== undefined) reply.header('content-length', foto.tamanho);
    return reply.send(foto.fluxo);
  });

  // -------------------------------------------------------------------------
  // Leilões (RF05, RF08, RF20)
  // -------------------------------------------------------------------------
  app.get('/api/leiloes', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listarLeiloes({
      status: lerStatus(q.status),
      pagina: lerPagina(q.pagina),
      categoria: q.categoria?.trim() || undefined,
      q: q.q,
    });
  });

  app.post('/api/leiloes', async (req, reply) => {
    const usuario = await exigirLogin(req);
    const id = await criarLeilao(usuario, req.body);
    return reply.status(201).send({ leilao: await detalharLeilao(id, usuario) });
  });

  app.get('/api/leiloes/:id', async (req) => {
    const id = lerId((req.params as { id: string }).id, 'Leilão');
    return { leilao: await detalharLeilao(id, await usuarioDe(req)) };
  });

  app.post('/api/leiloes/:id/cancelar', async (req) => {
    const usuario = await exigirLogin(req);
    const id = lerId((req.params as { id: string }).id, 'Leilão');
    await cancelarLeilao(usuario, id);
    return { leilao: await detalharLeilao(id, usuario) };
  });

  /** Leilões que eu anunciei, em qualquer estado. */
  app.get('/api/eu/leiloes', async (req) => {
    const usuario = await exigirLogin(req);
    const q = req.query as Record<string, string | undefined>;
    return listarLeiloes({ comitenteId: usuario.id, status: [...STATUS], pagina: lerPagina(q.pagina) });
  });

  // -------------------------------------------------------------------------
  // Nível 2
  // -------------------------------------------------------------------------

  /** RF23: edição conforme a política (ver `eu.edicao` no detalhe). */
  app.patch('/api/leiloes/:id', async (req) => {
    const usuario = await exigirLogin(req);
    const id = lerId((req.params as { id: string }).id, 'Leilão');
    await editarLeilao(usuario, id, req.body);
    return { leilao: await detalharLeilao(id, usuario) };
  });

  /** RF28: novo leilão para o mesmo item. */
  app.post('/api/leiloes/:id/relistar', async (req, reply) => {
    const usuario = await exigirLogin(req);
    const id = lerId((req.params as { id: string }).id, 'Leilão');
    const novo = await relistarLeilao(usuario, id, req.body);
    return reply.status(201).send({ leilao: await detalharLeilao(novo, usuario) });
  });

  /** RF27 */
  app.get('/api/eu/participacoes', async (req) => minhasParticipacoes(await exigirLogin(req)));

  /** RF22: busca e perfil público de comitentes. */
  app.get('/api/comitentes', async (req) => buscarComitentes((req.query as Record<string, string | undefined>).q));

  app.get('/api/comitentes/:id', async (req) => {
    const id = lerId((req.params as { id: string }).id, 'Comitente');
    return perfilDoComitente(id, lerPagina((req.query as Record<string, string | undefined>).pagina));
  });

  return app;
}
