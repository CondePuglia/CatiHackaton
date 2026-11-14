import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ToastNotification } from '@carbon/react';
import { io } from 'socket.io-client';
import { reais, useSessao } from './comuns';

type AvisoSuperado = {
  leilaoId: number;
  itemNome: string;
  valorCentavos: number;
};

/**
 * RF26: o servidor avisa quem foi superado em qualquer página. A sala já mostra
 * o aviso inline; fora dela, este provedor escuta o socket do usuário e mostra
 * um toast. Um único socket por sessão, sem interferir no socket da sala.
 */
export function ProvedorAvisos({ children }: { children: ReactNode }) {
  const { usuario } = useSessao();
  const local = useLocation();
  const [aviso, setAviso] = useState<AvisoSuperado | null>(null);
  const emSala = /^\/leiloes\/\d+\/sala/.test(local.pathname);
  const emSalaRef = useRef(emSala);
  emSalaRef.current = emSala;

  useEffect(() => {
    if (!usuario) {
      setAviso(null);
      return;
    }
    const socket = io({ transports: ['websocket', 'polling'] });
    socket.on('lance:superado', (dados: AvisoSuperado) => {
      // Dentro da sala, quem mostra é o aviso inline da própria Sala.
      if (emSalaRef.current) return;
      setAviso(dados);
    });
    return () => {
      socket.close();
    };
  }, [usuario]);

  useEffect(() => {
    if (emSala) setAviso(null);
  }, [emSala]);

  return (
    <>
      {children}
      {aviso && !emSala && (
        <div className="avisos-globais" aria-live="polite">
          <ToastNotification
            kind="warning"
            title="Seu lance foi superado"
            subtitle={`${aviso.itemNome}. Novo preço: ${reais(aviso.valorCentavos)}.`}
            caption="Aviso em tempo real"
            timeout={8000}
            onClose={() => setAviso(null)}
          />
        </div>
      )}
    </>
  );
}
