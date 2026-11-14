import { hash, verify } from '@node-rs/argon2';
import { config } from './config.js';
import { pool, violouUnicidade } from './db.js';
import { ErroApp } from './erros.js';
import { pontuacaoDoUsuario } from './credito.js';
import type { Usuario } from './sessoes.js';
import { Validador, objeto } from './validacao.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hash usado quando o e-mail não existe, para o login levar o mesmo tempo nos
// dois casos e não revelar quais e-mails têm conta.
let hashFalso: Promise<string> | null = null;
const obterHashFalso = () => (hashFalso ??= hash('senha-que-ninguem-usa'));

function normalizarEmail(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

/** RF01: cadastro com nome de exibição, e-mail, senha e renda mensal (RF29). */
export async function cadastrar(corpo: unknown): Promise<Usuario> {
  const dados = objeto(corpo);
  const v = new Validador();
  const nome = v.texto(dados.nome, 'nome', config.limites.nomeUsuario, 'o nome de exibição');
  const email = normalizarEmail(dados.email);
  if (!EMAIL.test(email) || email.length > 254) v.erro('email', 'Informe um e-mail válido.');
  const senha = typeof dados.senha === 'string' ? dados.senha : '';
  if (senha.length < config.limites.senha.min || senha.length > config.limites.senha.max) {
    v.erro('senha', `A senha precisa ter pelo menos ${config.limites.senha.min} caracteres.`);
  }
  const rendaMensalCentavos = v.inteiro(
    dados.rendaMensalCentavos,
    'rendaMensalCentavos',
    { min: 0, max: Number.MAX_SAFE_INTEGER },
    'Informe a renda mensal em centavos (0 ou mais).',
  );
  v.verificar();

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, renda_mensal_centavos)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nome, email, criado_em, renda_mensal_centavos, comitente_desde`,
      [nome, email, await hash(senha), rendaMensalCentavos],
    );
    const r = rows[0];
    return {
      id: r.id,
      nome: r.nome,
      email: r.email,
      criadoEm: r.criado_em,
      rendaMensalCentavos: r.renda_mensal_centavos,
      comitenteDesde: r.comitente_desde,
    };
  } catch (erro) {
    if (violouUnicidade(erro, 'usuarios_email_unico')) {
      throw new ErroApp(409, 'EMAIL_JA_CADASTRADO', 'Este e-mail já tem uma conta.', {
        email: 'Este e-mail já tem uma conta. Faça login.',
      });
    }
    throw erro;
  }
}

export async function autenticar(corpo: unknown): Promise<Usuario> {
  const dados = objeto(corpo);
  const email = normalizarEmail(dados.email);
  const senha = typeof dados.senha === 'string' ? dados.senha : '';

  const { rows } = await pool.query(
    'SELECT id, nome, email, senha_hash, criado_em, renda_mensal_centavos, comitente_desde FROM usuarios WHERE lower(email) = $1',
    [email],
  );
  const r = rows[0];
  const confere = await verify(r ? r.senha_hash : await obterHashFalso(), senha).catch(() => false);
  if (!r || !confere) {
    throw new ErroApp(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha incorretos.');
  }
  return {
    id: r.id,
    nome: r.nome,
    email: r.email,
    criadoEm: r.criado_em,
    rendaMensalCentavos: r.renda_mensal_centavos ?? 0,
    comitenteDesde: r.comitente_desde,
  };
}

/** RF30: a visão pública do usuário traz se ele pode vender e a pontuação. */
export async function usuarioPublico(u: Usuario) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email,
    criadoEm: u.criadoEm.toISOString(),
    comitente: u.comitenteDesde !== null,
    pontuacao: await pontuacaoDoUsuario(u.id),
  };
}
