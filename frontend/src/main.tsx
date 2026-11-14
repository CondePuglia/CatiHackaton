import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProvedorSessao, botaoSecundario, useSessao } from './comuns';
import { Cadastro, Entrar } from './Conta';
import { Detalhe } from './Detalhe';
import { Listagem } from './Listagem';
import { NovoLeilao } from './NovoLeilao';
import { Sala } from './Sala';
import './estilo.css';

function Topo() {
  const { usuario, sair } = useSessao();
  const item = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium ${isActive ? 'text-indigo-700' : 'text-slate-600 hover:text-slate-900'}`;
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link to="/" className="text-lg font-bold text-indigo-700">
          Leilão ao vivo
        </Link>
        <nav className="flex flex-1 flex-wrap items-center gap-4">
          <NavLink to="/" end className={item}>
            Leilões
          </NavLink>
          {usuario && (
            <>
              <NavLink to="/meus-leiloes" className={item}>
                Meus leilões
              </NavLink>
              <NavLink to="/leiloes/novo" className={item}>
                Anunciar item
              </NavLink>
            </>
          )}
        </nav>
        {usuario ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">Olá, {usuario.nome}</span>
            <button className={botaoSecundario} onClick={() => void sair()}>
              Sair
            </button>
          </div>
        ) : usuario === null ? (
          <div className="flex items-center gap-3">
            <Link to="/entrar" className={botaoSecundario}>
              Entrar
            </Link>
            <Link to="/cadastro" className="text-sm font-semibold text-indigo-700">
              Criar conta
            </Link>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** RF04: a sala e as ações de comitente exigem login; a listagem não. */
function ExigeLogin({ children }: { children: JSX.Element }) {
  const { usuario } = useSessao();
  const local = useLocation();
  if (usuario === undefined) return <p className="p-8 text-sm text-slate-500">Carregando…</p>;
  if (usuario === null) return <Navigate to={`/entrar?volta=${encodeURIComponent(local.pathname)}`} replace />;
  return children;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ProvedorSessao>
        <Topo />
        <main className="mx-auto max-w-6xl px-4 py-6">
          <Routes>
            <Route path="/" element={<Listagem />} />
            <Route path="/entrar" element={<Entrar />} />
            <Route path="/cadastro" element={<Cadastro />} />
            <Route path="/meus-leiloes" element={<ExigeLogin><Listagem meus /></ExigeLogin>} />
            <Route path="/leiloes/novo" element={<ExigeLogin><NovoLeilao /></ExigeLogin>} />
            <Route path="/leiloes/:id" element={<Detalhe />} />
            <Route path="/leiloes/:id/sala" element={<ExigeLogin><Sala /></ExigeLogin>} />
            <Route path="*" element={<p className="text-slate-600">Página não encontrada.</p>} />
          </Routes>
        </main>
      </ProvedorSessao>
    </BrowserRouter>
  </StrictMode>,
);
