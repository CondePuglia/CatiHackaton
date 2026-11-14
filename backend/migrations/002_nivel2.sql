-- Nível 2.
-- RF21/RF22: busca que ignora acentos ("camera" encontra "Câmera").
CREATE EXTENSION IF NOT EXISTS unaccent;
-- RF13: instante do último lance avaliado de cada usuário (limite de frequência).
ALTER TABLE usuarios ADD COLUMN ultimo_lance_em TIMESTAMPTZ;
