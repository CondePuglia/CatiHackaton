import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, useTitulo, type Leilao } from './comuns';
import { Aviso, EstadoVazio, VoltarLink } from './ui';
import { NovoLeilao } from './NovoLeilao';

function Carregar({ acao }: { acao: 'editar' | 'relistar' }) {
  const { id } = useParams();
  const [leilao, setLeilao] = useState<Leilao | null>(null);
  const [erro, setErro] = useState('');

  useTitulo(acao === 'editar' ? 'Editar leilão' : 'Relistar item');

  useEffect(() => {
    let vivo = true;
    api<{ leilao: Leilao }>(`/leiloes/${id}`)
      .then((r) => vivo && setLeilao(r.leilao))
      .catch((e) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, [id]);

  if (erro) {
    return (
      <div className="pagina pagina--estreita">
        <VoltarLink para={`/leiloes/${id}`}>Voltar ao leilão</VoltarLink>
        <Aviso tipo="erro" titulo="Leilão indisponível">
          {erro}
        </Aviso>
      </div>
    );
  }

  if (!leilao) {
    return (
      <div className="pagina">
        <p className="carregando">Carregando leilão…</p>
      </div>
    );
  }

  const modo = leilao.eu?.edicao ?? 'NADA';
  const podeEditar = acao === 'editar' && modo !== 'NADA';
  const podeRelistar = acao === 'relistar' && Boolean(leilao.eu?.podeRelistar);

  if (acao === 'editar' && !podeEditar) {
    return (
      <div className="pagina pagina--estreita">
        <VoltarLink para={`/leiloes/${leilao.id}`}>Voltar ao leilão</VoltarLink>
        <EstadoVazio
          titulo="Este leilão não pode mais ser editado"
          texto={
            modo === 'NADA'
              ? 'Faltam 30 minutos ou menos para o início, ou o leilão já foi encerrado. Nesse caso, a edição fica bloqueada.'
              : 'Você não tem permissão para editar este leilão.'
          }
        />
      </div>
    );
  }

  if (acao === 'relistar' && !podeRelistar) {
    return (
      <div className="pagina pagina--estreita">
        <VoltarLink para={`/leiloes/${leilao.id}`}>Voltar ao leilão</VoltarLink>
        <EstadoVazio
          titulo="Este item não pode ser relistado"
          texto="Só dá para relistar um leilão encerrado sem lances ou cancelado. Um item nunca pode ter dois leilões ativos ao mesmo tempo."
        />
      </div>
    );
  }

  return <NovoLeilao acao={acao} leilao={leilao} />;
}

export const EditarLeilao = () => <Carregar acao="editar" />;
export const RelistarLeilao = () => <Carregar acao="relistar" />;
