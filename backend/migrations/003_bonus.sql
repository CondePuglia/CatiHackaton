-- Bônus (RF29–RF32): pontuação, habilitação de comitente e limite de crédito.
-- A renda mensal alimenta o limite de crédito; comitente_desde marca quem já se
-- habilitou a vender (RF30). Nada é obrigatório aqui: contas antigas ganham
-- renda 0 (sem crédito) e podem se habilitar quando a pontuação permitir.

ALTER TABLE usuarios
  ADD COLUMN renda_mensal_centavos BIGINT,
  ADD COLUMN comitente_desde TIMESTAMPTZ;

ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_renda_nao_negativa
  CHECK (renda_mensal_centavos IS NULL OR renda_mensal_centavos >= 0);

-- RF31: a reserva de crédito é a soma dos leilões em andamento que o usuário
-- lidera. Índices para essas duas somas.
CREATE INDEX leiloes_lider_ativo ON leiloes (lider_id) WHERE status = 'EM_ANDAMENTO';
CREATE INDEX leiloes_lider_vendido ON leiloes (lider_id) WHERE status = 'VENDIDO';
