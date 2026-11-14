import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Aviso, Campo, ErroApi, api, botao, campo, useSessao } from './comuns';

function Formulario({ cadastro }: { cadastro: boolean }) {
  const { usuario, definir } = useSessao();
  const navegar = useNavigate();
  const [busca] = useSearchParams();
  const volta = busca.get('volta') || '/';
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<ErroApi | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (usuario) return <Navigate to={volta} replace />;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const r = await api(cadastro ? '/usuarios' : '/sessao', { corpo: cadastro ? { nome, email, senha } : { email, senha } });
      definir(r.usuario);
      navegar(volta, { replace: true });
    } catch (falha) {
      setErro(falha as ErroApi);
    } finally {
      setEnviando(false);
    }
  }

  const campos = erro?.campos ?? {};
  return (
    <div className="mx-auto max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-4 text-xl font-bold">{cadastro ? 'Criar conta' : 'Entrar'}</h1>
      <form onSubmit={enviar} className="space-y-4" noValidate>
        {erro && Object.keys(campos).length === 0 && <Aviso>{erro.message}</Aviso>}
        {cadastro && (
          <Campo rotulo="Nome de exibição" erro={campos.nome}>
            <input className={campo} value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="name" />
          </Campo>
        )}
        <Campo rotulo="E-mail" erro={campos.email}>
          <input className={campo} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Campo>
        <Campo rotulo="Senha" erro={campos.senha} dica={cadastro ? 'Pelo menos 8 caracteres.' : undefined}>
          <input
            className={campo}
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete={cadastro ? 'new-password' : 'current-password'}
          />
        </Campo>
        <button className={`${botao} w-full`} disabled={enviando}>
          {enviando ? 'Enviando…' : cadastro ? 'Criar conta' : 'Entrar'}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        {cadastro ? 'Já tem conta? ' : 'Ainda não tem conta? '}
        <Link className="font-semibold text-indigo-700" to={`${cadastro ? '/entrar' : '/cadastro'}?volta=${encodeURIComponent(volta)}`}>
          {cadastro ? 'Entrar' : 'Criar conta'}
        </Link>
      </p>
    </div>
  );
}

export const Entrar = () => <Formulario cadastro={false} />;
export const Cadastro = () => <Formulario cadastro />;
