# Frontend — Cati Leilões

Interface da plataforma de leilão online em tempo real. A tela não calcula regra de negócio: mostra a fotografia que o servidor envia e usa o relógio do servidor para a contagem.

## Stack

- **React 18 + Vite 6 + TypeScript**.
- **Carbon Design System** (`@carbon/react`, `@carbon/styles`, `@carbon/icons-react`) para componentes, estados, acessibilidade e tokens.
- **Tailwind 4** para utilitários de layout, sem o preflight global — o reset do Carbon continua sendo a base.
- **IBM Plex Sans** (texto), **IBM Plex Serif** (títulos e preços) e **IBM Plex Mono** (tempo e dados), self-hosted via `@fontsource`.
- **Socket.IO** para a sala em tempo real.

## Como rodar

```bash
cd frontend
npm install
npm run dev
```

O Vite abre em `http://localhost:5173` e faz proxy de `/api` e `/socket.io` para `http://localhost:8080` (a pilha do Docker Compose). Para apontar para outro endereço:

```bash
API_URL=http://192.168.0.10:8080 npm run dev
```

Build de produção:

```bash
npm run build   # tsc --noEmit + vite build
```

No Docker, o `Dockerfile` já roda o build e o Caddy serve `dist` junto com o proxy da API.

## Estrutura

```text
frontend/
├── src/
│   ├── main.tsx        # rotas, casca, fontes e CSS do Carbon
│   ├── comuns.tsx      # API, sessão, relógio do servidor, tipos, formatação
│   ├── ui.tsx          # cabeçalho, rodapé, cartão, galeria, avisos, vazio
│   ├── Listagem.tsx    # home e "Meus leilões" (busca, filtros, paginação, destaque)
│   ├── Detalhe.tsx     # detalhe público, galeria, painel de preço, regras
│   ├── Sala.tsx        # sala Socket.IO, lance, contagem, presença e espectador
│   ├── NovoLeilao.tsx  # criar, editar, complementar descrição e relistar
│   ├── GerenciarLeilao.tsx # carrega o leilão e aplica a política de edição
│   ├── Comitentes.tsx  # busca e perfil público de comitentes
│   ├── Participacoes.tsx # "Minhas participações" e situação em cada leilão
│   ├── MinhaConta.tsx  # pontuação (RF29), crédito, reservas e histórico de compras
│   ├── Metricas.tsx    # painel de /api/metricas para a demo
│   ├── avisos.tsx      # RF26: toast global de lance superado
│   ├── Conta.tsx       # entrar/cadastrar e contas de demonstração
│   └── estilo.css      # tokens, identidade visual, layout e responsivo
├── DESIGN.md           # decisões de design e sistema visual
└── index.html
```

## Contrato respeitado

- Dinheiro sempre em centavos inteiros; conversão para texto só na borda da UI.
- Horários no fuso de quem vê; a contagem usa `agora` do servidor e ignora o relógio local.
- `versao` da sala descarta estados fora de ordem.
- `chave` por tentativa de lance, com reenvio da mesma chave em falha de rede.
- Sessão por cookie HttpOnly; a UI reage a `401` e a `connect_error: NAO_AUTENTICADO`.
- Limites, categorias e incrementos vêm de `GET /api/config`.
- Nível 2: busca por nome (`q`), perfil de comitente, edição (tudo ou complemento), relistagem,
  espectador com presença e "Minhas participações". O aviso de lance superado usa o evento
  `lance:superado` e a descrição editada recarrega com `sala:item`.
- Bônus 7.1: renda mensal no cadastro, pontuação no cabeçalho, "Quero vender" (habilitação com 50 pontos),
  crédito disponível na sala, espectador automático por crédito e reserva indicada em "Minhas participações".
- Bônus 7.2 na tela: `/metricas` mostra os indicadores de `/api/metricas` e as séries brutas; RF26 usa
  um socket global para avisar quem foi superado fora da sala.

## Acessibilidade

- Auditado com `axe-core` (WCAG 2.0 A/AA) em home, detalhe, sala, anúncio, conta, comitentes,
  perfil, participações, edição, relistagem, cadastro com renda, "Quero vender", crédito, modo
  espectador, métricas e aviso global: **0 violações** em desktop e mobile.
- Foco visível, link "Pular para o conteúdo", labels Carbon, `aria-live` para o resumo da sala, contagem com `aria-label` e respeito a `prefers-reduced-motion`.
