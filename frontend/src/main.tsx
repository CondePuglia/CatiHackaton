import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-serif/latin-400.css';
import '@fontsource/ibm-plex-serif/latin-600.css';
import '@carbon/styles/css/styles.css';
import './estilo.css';
import { Button } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { ProvedorSessao, useSessao, useTitulo } from './comuns';
import { Cabecalho, EstadoVazio, IrParaConteudo, Rodape } from './ui';
import { Cadastro, Entrar } from './Conta';
import { BuscaComitentes, PerfilDoComitente } from './Comitentes';
import { Detalhe } from './Detalhe';
import { EditarLeilao, RelistarLeilao } from './GerenciarLeilao';
import { Listagem } from './Listagem';
import { MinhasParticipacoes } from './Participacoes';
import { MinhaConta } from './MinhaConta';
import { NovoLeilao } from './NovoLeilao';
import { Sala } from './Sala';

/** RF04: a sala e as ações de comitente exigem login; a listagem não. */
function ExigeLogin({ children }: { children: ReactNode }) {
  const { usuario } = useSessao();
  const local = useLocation();
  if (usuario === undefined) return <p className="carregando">Carregando…</p>;
  if (usuario === null) {
    const volta = encodeURIComponent(`${local.pathname}${local.search}`);
    return <Navigate to={`/entrar?volta=${volta}`} replace />;
  }
  return <>{children}</>;
}

function AoTrocarRota() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function NaoEncontrado() {
  useTitulo('Página não encontrada');
  return (
    <div className="pagina pagina--estreita">
      <EstadoVazio
        titulo="Esta página não existe"
        texto="O endereço pode estar errado ou o leilão pode ter saído do catálogo."
        acao={
          <Button as={Link} to="/" kind="primary" renderIcon={ArrowRight}>
            Ver leilões
          </Button>
        }
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ProvedorSessao>
        <AoTrocarRota />
        <IrParaConteudo />
        <Cabecalho />
        <main id="conteudo" className="conteudo">
          <Routes>
            <Route path="/" element={<Listagem />} />
            <Route path="/entrar" element={<Entrar />} />
            <Route path="/cadastro" element={<Cadastro />} />
            <Route
              path="/meus-leiloes"
              element={
                <ExigeLogin>
                  <Listagem meus />
                </ExigeLogin>
              }
            />
            <Route
              path="/minhas-participacoes"
              element={
                <ExigeLogin>
                  <MinhasParticipacoes />
                </ExigeLogin>
              }
            />
            <Route
              path="/minha-conta"
              element={
                <ExigeLogin>
                  <MinhaConta />
                </ExigeLogin>
              }
            />
            <Route path="/comitentes" element={<BuscaComitentes />} />
            <Route path="/comitentes/:id" element={<PerfilDoComitente />} />
            <Route
              path="/leiloes/novo"
              element={
                <ExigeLogin>
                  <NovoLeilao />
                </ExigeLogin>
              }
            />
            <Route path="/leiloes/:id" element={<Detalhe />} />
            <Route
              path="/leiloes/:id/editar"
              element={
                <ExigeLogin>
                  <EditarLeilao />
                </ExigeLogin>
              }
            />
            <Route
              path="/leiloes/:id/relistar"
              element={
                <ExigeLogin>
                  <RelistarLeilao />
                </ExigeLogin>
              }
            />
            <Route
              path="/leiloes/:id/sala"
              element={
                <ExigeLogin>
                  <Sala />
                </ExigeLogin>
              }
            />
            <Route path="*" element={<NaoEncontrado />} />
          </Routes>
        </main>
        <Rodape />
      </ProvedorSessao>
    </BrowserRouter>
  </StrictMode>,
);
