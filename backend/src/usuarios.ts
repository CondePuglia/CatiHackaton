import { hash, verify } from '@node-rs/argon2';
import { config } from './config.js';
import { pool, violouUnicidade } from './db.js';
import { ErroApp } from './erros.js';
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

/** RF01: cadastro com nome de exibição, e-mail e senha. */
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
  v.verificar();

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3)
       RETURNING id, nome, email, criado_em`,
      [nome, email, await hash(senha)],
    );
    const r = rows[0];
    return { id: r.id, nome: r.nome, email: r.email, criadoEm: r.criado_em };
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
    'SELECT id, nome, email, senha_hash, criado_em FROM usuarios WHERE lower(email) = $1',
    [email],
  );
  const r = rows[0];
  const confere = await verify(r ? r.senha_hash : await obterHashFalso(), senha).catch(() => false);
  if (!r || !confere) {
    throw new ErroApp(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha incorretos.');
  }
  return { id: r.id, nome: r.nome, email: r.email, criadoEm: r.criado_em };
}

export const usuarioPublico = (u: Usuario) => ({
  id: u.id,
  nome: u.nome,
  email: u.email,
  criadoEm: u.criadoEm.toISOString(),
});
