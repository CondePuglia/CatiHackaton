import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import { pool } from '../../src/db.js';
import { criarApp } from '../../src/http.js';
import { encerrar, preparar } from './apoio.js';

let app: FastifyInstance;

before(async () => {
  await preparar();
  app = await criarApp();
});

after(async () => {
  await app.close();
  await encerrar();
});

const cadastro = (dados: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/usuarios', payload: { rendaMensalCentavos: 5000_00, ...dados } });

const cookieDe = (resposta: { cookies: Array<{ name: string; value: string }> }): string => {
  const c = resposta.cookies.find((x) => x.name === config.sessao.cookie);
  assert.ok(c, 'a resposta deveria trazer o cookie de sessão');
  return c.value;
};

const eu = (token?: string) =>
  app.inject({ method: 'GET', url: '/api/eu', cookies: token ? { [config.sessao.cookie]: token } : {} });

test('RF01: cadastro com nome, e-mail e senha cria a conta e já abre a sessão', async () => {
  const r = await cadastro({ nome: 'Ana Souza', email: 'Ana@Exemplo.com', senha: 'segredo-forte' });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().usuario.nome, 'Ana Souza');
  assert.equal(r.json().usuario.email, 'ana@exemplo.com');
  assert.equal(r.json().usuario.senha, undefined);

  const bruto = r.cookies.find((c) => c.name === config.sessao.cookie) as { httpOnly?: boolean; sameSite?: string };
  assert.equal(bruto.httpOnly, true, 'o cookie de sessão é HttpOnly');
  assert.equal(String(bruto.sameSite).toLowerCase(), 'lax');

  const quem = await eu(cookieDe(r));
  assert.equal(quem.statusCode, 200);
  assert.equal(quem.json().usuario.email, 'ana@exemplo.com');
});

test('RF01: um e-mail identifica uma única conta, sem diferenciar maiúsculas', async () => {
  const a = await cadastro({ nome: 'Bruno', email: 'bruno@exemplo.com', senha: 'segredo-forte' });
  assert.equal(a.statusCode, 201);
  const b = await cadastro({ nome: 'Outro Bruno', email: '  BRUNO@exemplo.COM ', senha: 'outra-senha-1' });
  assert.equal(b.statusCode, 409);
  assert.equal(b.json().erro.codigo, 'EMAIL_JA_CADASTRADO');
  assert.ok(b.json().erro.campos.email);
  const { rows } = await pool.query(`SELECT count(*) AS n FROM usuarios WHERE lower(email) = 'bruno@exemplo.com'`);
  assert.equal(rows[0].n, 1);
});

test('RF01: dados inválidos voltam com o erro de cada campo', async () => {
  const r = await cadastro({ nome: 'A', email: 'sem-arroba', senha: '123' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().erro.codigo, 'VALIDACAO');
  assert.deepEqual(Object.keys(r.json().erro.campos).sort(), ['email', 'nome', 'senha']);
});

test('RF29: a renda mensal é obrigatória, inteira e não negativa', async () => {
  const semRenda = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    payload: { nome: 'Sem Renda', email: 'sem-renda@exemplo.com', senha: 'segredo-forte' },
  });
  assert.equal(semRenda.statusCode, 422);
  assert.ok(semRenda.json().erro.campos.rendaMensalCentavos);

  const negativa = await cadastro({ rendaMensalCentavos: -1 });
  assert.equal(negativa.statusCode, 422);
  assert.ok(negativa.json().erro.campos.rendaMensalCentavos);

  const quebrada = await cadastro({ rendaMensalCentavos: 100.5 });
  assert.equal(quebrada.statusCode, 422);
  assert.ok(quebrada.json().erro.campos.rendaMensalCentavos);
});

test('a senha nunca é guardada em claro', async () => {
  await cadastro({ nome: 'Clara', email: 'clara@exemplo.com', senha: 'minha-senha-secreta' });
  const { rows } = await pool.query(`SELECT senha_hash FROM usuarios WHERE email = 'clara@exemplo.com'`);
  assert.match(rows[0].senha_hash, /^\$argon2id\$/);
  assert.ok(!rows[0].senha_hash.includes('minha-senha-secreta'));
});

test('RF01: login com senha certa abre sessão; com senha errada ou e-mail inexistente, não', async () => {
  await cadastro({ nome: 'Davi', email: 'davi@exemplo.com', senha: 'senha-do-davi' });

  const errada = await app.inject({
    method: 'POST',
    url: '/api/sessao',
    payload: { email: 'davi@exemplo.com', senha: 'senha-errada' },
  });
  assert.equal(errada.statusCode, 401);
  assert.equal(errada.json().erro.codigo, 'CREDENCIAIS_INVALIDAS');

  const inexistente = await app.inject({
    method: 'POST',
    url: '/api/sessao',
    payload: { email: 'ninguem@exemplo.com', senha: 'senha-do-davi' },
  });
  assert.equal(inexistente.statusCode, 401);
  assert.equal(inexistente.json().erro.mensagem, errada.json().erro.mensagem, 'a mensagem não revela se o e-mail existe');

  const certa = await app.inject({
    method: 'POST',
    url: '/api/sessao',
    payload: { email: 'DAVI@exemplo.com', senha: 'senha-do-davi' },
  });
  assert.equal(certa.statusCode, 200);
  assert.equal((await eu(cookieDe(certa))).statusCode, 200);
});

test('RF02: ação protegida sem sessão é recusada com 401', async () => {
  for (const rota of [
    { method: 'GET', url: '/api/eu' },
    { method: 'GET', url: '/api/eu/leiloes' },
    { method: 'POST', url: '/api/leiloes', payload: {} },
    { method: 'POST', url: '/api/fotos', payload: {} },
    { method: 'POST', url: '/api/leiloes/1/cancelar' },
  ] as const) {
    const r = await app.inject(rota);
    assert.equal(r.statusCode, 401, `${rota.method} ${rota.url}`);
    assert.equal(r.json().erro.codigo, 'NAO_AUTENTICADO');
  }
  const falso = await eu('token-inventado');
  assert.equal(falso.statusCode, 401);
});

test('RF02: a sessão expira', async () => {
  const r = await cadastro({ nome: 'Elisa', email: 'elisa@exemplo.com', senha: 'senha-da-elisa' });
  const token = cookieDe(r);
  assert.equal((await eu(token)).statusCode, 200);

  await pool.query(
    `UPDATE sessoes SET expira_em = clock_timestamp() - interval '1 second'
      WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'elisa@exemplo.com')`,
  );
  const depois = await eu(token);
  assert.equal(depois.statusCode, 401);
  assert.equal(depois.json().erro.codigo, 'NAO_AUTENTICADO');
});

test('RF02: a sessão se renova com o uso, mas só até o teto absoluto', async () => {
  const r = await cadastro({ nome: 'Fabio', email: 'fabio@exemplo.com', senha: 'senha-do-fabio' });
  const token = cookieDe(r);
  const ler = async () =>
    (
      await pool.query(
        `SELECT expira_em, criada_em FROM sessoes
          WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'fabio@exemplo.com')`,
      )
    ).rows[0];

  // quase expirando: um uso devolve o prazo inteiro de inatividade
  await pool.query(
    `UPDATE sessoes SET expira_em = clock_timestamp() + interval '2 seconds'
      WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'fabio@exemplo.com')`,
  );
  assert.equal((await eu(token)).statusCode, 200);
  const renovada = await ler();
  const faltam = (renovada.expira_em.getTime() - Date.now()) / 1000;
  assert.ok(
    faltam > config.sessao.inatividadeSegundos - 30 && faltam <= config.sessao.inatividadeSegundos + 5,
    `o prazo deveria ter voltado para ~${config.sessao.inatividadeSegundos}s (faltam ${faltam}s)`,
  );

  // sessão criada há quase o teto: a renovação não passa de criada_em + máximo
  await pool.query(
    `UPDATE sessoes SET criada_em = clock_timestamp() - make_interval(secs => $1), expira_em = clock_timestamp() + interval '5 seconds'
      WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'fabio@exemplo.com')`,
    [config.sessao.maximoSegundos - 60],
  );
  assert.equal((await eu(token)).statusCode, 200);
  const noTeto = await ler();
  const teto = noTeto.criada_em.getTime() + config.sessao.maximoSegundos * 1000;
  assert.equal(noTeto.expira_em.getTime(), teto, 'a renovação parou no teto absoluto');
});

test('RF02: sair encerra a sessão no servidor — o cookie antigo deixa de valer', async () => {
  const r = await cadastro({ nome: 'Gabi', email: 'gabi@exemplo.com', senha: 'senha-da-gabi' });
  const token = cookieDe(r);
  const sair = await app.inject({ method: 'DELETE', url: '/api/sessao', cookies: { [config.sessao.cookie]: token } });
  assert.equal(sair.statusCode, 204);
  assert.equal((await eu(token)).statusCode, 401);
});

test('o banco guarda só o hash do token de sessão', async () => {
  const r = await cadastro({ nome: 'Hugo', email: 'hugo@exemplo.com', senha: 'senha-do-hugo' });
  const token = cookieDe(r);
  const { rows } = await pool.query('SELECT token_hash FROM sessoes');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((s) => s.token_hash !== token && /^[0-9a-f]{64}$/.test(s.token_hash)));
});

test('RF03: não existe administrador nem papel de usuário no banco', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'usuarios' ORDER BY 1`,
  );
  const colunas = rows.map((c) => c.column_name);
  assert.ok(!colunas.some((c) => /admin|papel|role/.test(c)), `colunas: ${colunas.join(', ')}`);
});

test('corpo malformado devolve erro 4xx em JSON, não 500', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    payload: '{ isto não é json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().erro.codigo, 'REQUISICAO_INVALIDA');

  const lista = await app.inject({ method: 'POST', url: '/api/usuarios', payload: [1, 2, 3] });
  assert.equal(lista.statusCode, 400);

  const rota = await app.inject({ method: 'GET', url: '/api/nao-existe' });
  assert.equal(rota.statusCode, 404);
  assert.equal(rota.json().erro.codigo, 'NAO_ENCONTRADO');
});
