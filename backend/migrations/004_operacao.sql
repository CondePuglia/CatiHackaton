-- Bônus 7.2 (operação): mais de uma instância da API ao mesmo tempo.
--
-- RF25 pede que a sala mostre quantos participantes e espectadores há nela. Com
-- uma instância só, bastava contar os sockets em memória; com várias, cada uma
-- enxerga apenas os seus. A presença passa a morar no banco, como todo o resto
-- do estado: uma linha por (socket, leilão), marcada com a instância que a
-- mantém. Cada instância renova `visto_em` das suas linhas; se uma instância
-- morre sem avisar, as linhas dela envelhecem e o worker as apaga.

CREATE TABLE presencas (
  socket_id  TEXT        NOT NULL,
  leilao_id  BIGINT      NOT NULL REFERENCES leiloes (id) ON DELETE CASCADE,
  usuario_id BIGINT      NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  instancia  TEXT        NOT NULL,
  papel      TEXT        NOT NULL CHECK (papel IN ('PARTICIPANTE', 'ESPECTADOR', 'COMITENTE')),
  visto_em   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (socket_id, leilao_id)
);

CREATE INDEX presencas_leilao ON presencas (leilao_id);
CREATE INDEX presencas_instancia ON presencas (instancia);
