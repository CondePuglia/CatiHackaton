-- Núcleo: contas, itens, leilões, lances.
-- Regra geral: o que é invariante de negócio também é restrição no banco,
-- para que nem um bug na aplicação consiga gravar um estado impossível.

CREATE TABLE usuarios (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  senha_hash  TEXT        NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- RF01: um e-mail identifica uma única conta, sem diferenciar maiúsculas.
CREATE UNIQUE INDEX usuarios_email_unico ON usuarios (lower(email));

-- RF02: sessão no banco. Guardamos só o hash do token; o token vive no cookie.
CREATE TABLE sessoes (
  token_hash  TEXT        PRIMARY KEY,
  usuario_id  BIGINT      NOT NULL REFERENCES usuarios (id),
  criada_em   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expira_em   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessoes_expira ON sessoes (expira_em);

-- Item é o bem; leilão é uma venda dele. Um item pode ter vários leilões.
CREATE TABLE itens (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comitente_id  BIGINT      NOT NULL REFERENCES usuarios (id),
  nome          TEXT        NOT NULL,
  descricao     TEXT        NOT NULL,
  categoria     TEXT        NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- RF07: aqui fica só a referência; os bytes ficam no serviço de armazenamento.
CREATE TABLE fotos (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dono_id        BIGINT      NOT NULL REFERENCES usuarios (id),
  item_id        BIGINT      REFERENCES itens (id),
  ordem          INT         NOT NULL DEFAULT 0,
  chave          TEXT        NOT NULL UNIQUE,
  tipo           TEXT        NOT NULL,
  tamanho_bytes  INT         NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fotos_item ON fotos (item_id, ordem, id);

CREATE TABLE leiloes (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id                 BIGINT      NOT NULL REFERENCES itens (id),
  comitente_id            BIGINT      NOT NULL REFERENCES usuarios (id),
  status                  TEXT        NOT NULL DEFAULT 'AGENDADO',
  preco_inicial_centavos  BIGINT      NOT NULL,
  -- Precisão de milissegundo, a mesma do JavaScript: o que a aplicação lê é
  -- exatamente o que está gravado, sem sobra de microssegundo nas comparações.
  inicio_em               TIMESTAMPTZ(3) NOT NULL,
  termino_original_em     TIMESTAMPTZ(3) NOT NULL,
  termino_em              TIMESTAMPTZ(3) NOT NULL,
  preco_atual_centavos    BIGINT,
  lider_id                BIGINT      REFERENCES usuarios (id),
  total_lances            INT         NOT NULL DEFAULT 0,
  versao                  INT         NOT NULL DEFAULT 0,
  criado_em               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  aberto_em               TIMESTAMPTZ,
  encerrado_em            TIMESTAMPTZ,

  CONSTRAINT leiloes_status_valido CHECK (status IN
    ('AGENDADO', 'EM_ANDAMENTO', 'VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO')),
  CONSTRAINT leiloes_preco_positivo CHECK (preco_inicial_centavos > 0),
  CONSTRAINT leiloes_termino_apos_inicio CHECK (termino_original_em > inicio_em),
  -- prorrogação só empurra o término para frente
  CONSTRAINT leiloes_termino_nao_recua CHECK (termino_em >= termino_original_em),
  -- líder, preço atual e contagem andam juntos
  CONSTRAINT leiloes_lider_coerente CHECK ((total_lances = 0) = (lider_id IS NULL)),
  CONSTRAINT leiloes_preco_coerente CHECK ((total_lances = 0) = (preco_atual_centavos IS NULL)),
  CONSTRAINT leiloes_preco_atual_minimo CHECK (preco_atual_centavos IS NULL OR preco_atual_centavos >= preco_inicial_centavos),
  -- RF04: o comitente nunca lidera o próprio leilão
  CONSTRAINT leiloes_comitente_nao_lidera CHECK (lider_id IS NULL OR lider_id <> comitente_id),
  -- RN01: com lances só termina Vendido; sem lances nunca é Vendido
  CONSTRAINT leiloes_vendido_tem_lances CHECK (status <> 'VENDIDO' OR total_lances > 0),
  CONSTRAINT leiloes_sem_lances_nao_vende CHECK (status NOT IN ('ENCERRADO_SEM_LANCES', 'CANCELADO') OR total_lances = 0),
  -- só recebe lance depois de aberto
  CONSTRAINT leiloes_agendado_sem_lances CHECK (status <> 'AGENDADO' OR total_lances = 0)
);

-- RF28 (já vale desde o Núcleo): um item nunca tem dois leilões ativos.
CREATE UNIQUE INDEX leiloes_um_ativo_por_item ON leiloes (item_id)
  WHERE status IN ('AGENDADO', 'EM_ANDAMENTO');
-- Índices parciais: o worker só olha o que ainda pode mudar de estado.
CREATE INDEX leiloes_a_abrir  ON leiloes (inicio_em)  WHERE status = 'AGENDADO';
CREATE INDEX leiloes_a_fechar ON leiloes (termino_em) WHERE status = 'EM_ANDAMENTO';
CREATE INDEX leiloes_por_comitente ON leiloes (comitente_id, id DESC);
CREATE INDEX leiloes_por_status ON leiloes (status);

-- RN01: só estas cinco transições existem; estados finais não mudam mais.
CREATE FUNCTION leiloes_guardar_transicao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO') THEN
    RAISE EXCEPTION 'leilao % esta em estado final (%) e nao pode mudar', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'AGENDADO'     AND NEW.status IN ('EM_ANDAMENTO', 'CANCELADO'))
    OR (OLD.status = 'EM_ANDAMENTO' AND NEW.status IN ('VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO'))
  ) THEN
    RAISE EXCEPTION 'transicao invalida de % para % no leilao %', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER leiloes_transicao BEFORE UPDATE ON leiloes
  FOR EACH ROW EXECUTE FUNCTION leiloes_guardar_transicao();

CREATE TABLE lances (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leilao_id       BIGINT      NOT NULL REFERENCES leiloes (id),
  usuario_id      BIGINT      NOT NULL REFERENCES usuarios (id),
  valor_centavos  BIGINT      NOT NULL CHECK (valor_centavos > 0),
  sequencia       INT         NOT NULL CHECK (sequencia > 0),
  criado_em       TIMESTAMPTZ(3) NOT NULL,
  -- RF11: dois lances nunca ocupam a mesma posição na disputa
  CONSTRAINT lances_sequencia_unica UNIQUE (leilao_id, sequencia)
);
CREATE INDEX lances_por_usuario ON lances (usuario_id, leilao_id);

-- RF10: lance é irrevogável. Nem UPDATE nem DELETE.
CREATE FUNCTION lances_imutaveis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lances sao irrevogaveis: nao ha alteracao nem exclusao'
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER lances_sem_alteracao BEFORE UPDATE OR DELETE ON lances
  FOR EACH ROW EXECUTE FUNCTION lances_imutaveis();

-- RF09: na sala cada pessoa é "Participante N" (N = ordem em que entrou na disputa).
CREATE TABLE apelidos (
  leilao_id   BIGINT NOT NULL REFERENCES leiloes (id),
  usuario_id  BIGINT NOT NULL REFERENCES usuarios (id),
  numero      INT    NOT NULL,
  PRIMARY KEY (leilao_id, usuario_id),
  UNIQUE (leilao_id, numero)
);

-- RF12: cada tentativa de lance tem uma chave gerada no navegador.
-- A resposta original fica guardada; reenviar a chave devolve a mesma resposta.
CREATE TABLE tentativas_lance (
  usuario_id      BIGINT      NOT NULL REFERENCES usuarios (id),
  chave           TEXT        NOT NULL,
  leilao_id       BIGINT      NOT NULL,
  valor_centavos  BIGINT      NOT NULL,
  resultado       JSONB,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (usuario_id, chave)
);
