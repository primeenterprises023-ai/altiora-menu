# ALTIORA MENU — Digital Dining Experience

Plataforma de cardápios digitais e pedidos por QR Code para restaurantes. Um serviço da **Altiora Grupo**.

O cliente lê o QR Code da mesa com a câmara do telemóvel (sem instalar nenhuma aplicação), vê o cardápio com fotografias,
ingredientes, alergénios e, nos pratos que têm, o modelo em 3D e a realidade aumentada. Escolhe, faz o pedido e acompanha-o.
A cozinha, os empregados e o gerente recebem tudo em tempo real. A Altiora gere os restaurantes, os planos e as assinaturas.

> **Para quem não programa:** comece por [`docs/publicar.md`](docs/publicar.md) (como pôr o sistema na internet, passo a passo)
> e por [`docs/manual.md`](docs/manual.md) (como cada pessoa usa o sistema). Não precisa de ler o resto deste ficheiro.

## O que cada pessoa pode fazer

| Quem | O que faz |
|---|---|
| **Cliente** | Lê o QR Code da mesa (ou abre a página do restaurante); pesquisa e filtra o cardápio; vê o detalhe de cada prato (ingredientes, alergénios, tamanhos, extras); vê o prato em 3D e «na minha mesa» (realidade aumentada) quando existe modelo; monta o pedido, envia-o (pelo sistema ou por WhatsApp) e acompanha o estado; pode **chamar o garçom**. Não cria conta. |
| **Empregado** | Vê pedidos prontos a entregar, mesas, chamadas de mesa (com aviso sonoro) e pedidos por pagar; regista pedidos feitos à mão. |
| **Cozinha** | Vê os pedidos novos, inicia a preparação, marca como pronto; marca pratos esgotados. |
| **Gerente** | Gere o menu (pratos, fotografias, modelos 3D, alergénios, tamanhos e extras), as mesas e os QR Codes (PDF para imprimir), a equipa, os relatórios, as definições do restaurante e vê o seu plano. |
| **Altiora (administração)** | Cria e suspende restaurantes e gerentes, define os planos (Starter, Pro, Premium), os preços, as assinaturas e as funcionalidades de cada plano; vê números gerais de utilização e os contactos comerciais recebidos. **Não vê** os pedidos, os menus nem os relatórios dos restaurantes. |

Há ainda uma **página comercial** (a página inicial do site) com apresentação, planos e preços, demonstração interativa,
perguntas frequentes e formulário de contacto, e um **restaurante de demonstração fictício («Casa Aurora»)**.

## Os planos

Os planos são configuráveis pela Altiora (nomes, preços, funcionalidades). Ao instalar, ficam estes:

- **Starter**: cardápio digital, QR Code do restaurante em PDF, gestão de produtos.
- **Pro**: tudo do Starter + pedidos digitais, pedidos por WhatsApp, gestão de mesas, estatísticas, personalização (cor e tema).
- **Premium**: tudo do Pro + pratos em 3D, realidade aumentada, personalização exclusiva (sem a marca Altiora, estilo de letra) e gestão avançada (CSV e atividade da equipa).

Os preços **não vêm preenchidos**: enquanto a Altiora não os definir (painel da Altiora → Planos), a página comercial mostra «Preço sob consulta».

## Pagamentos

Este sistema **não cobra pagamentos** aos clientes dos restaurantes nem às assinaturas: não há cartões, nem referências, nem gateways.
A única função extra do cliente, além de pedir, é **«Chamar o garçom»**.
O que existe é um registo, feito pela **equipa**, de como a conta de uma mesa foi paga (por exemplo, dinheiro ou TPA), para os relatórios.
Está na aplicação desde as primeiras versões; se não o quiser, peça a sua remoção.

## Como está feito (resumo)

- **Servidor** em TypeScript, executado com [Bun](https://bun.sh). Uma única aplicação serve a API, a página comercial e as páginas dos painéis.
- **Base de dados** PostgreSQL. A separação entre restaurantes é garantida **pela própria base de dados** (RLS, uma regra por tabela),
  e não só pelo código: mesmo um erro no código não mostra dados de outro restaurante.
- **Aplicação web** em React 19, desenhada primeiro para telemóvel; o 3D usa Three.js (só é descarregado quando alguém abre um prato em 3D).
- **Tempo real** por SSE (os painéis e o ecrã de acompanhamento do cliente atualizam sozinhos; se a ligação falhar, voltam a consultar a cada poucos segundos).
- Mais pormenores, decisões e desvios em relação ao que foi pedido: [`docs/arquitetura.md`](docs/arquitetura.md).

## Instalar no seu computador (para quem programa)

Precisa de [Bun](https://bun.sh) 1.2 ou superior e de PostgreSQL (testado com a versão 16).

```bash
bun install                                   # dependências de construção e de testes
createdb altiora                              # base de dados vazia
cat > .env <<'EOF'
DATABASE_URL=postgres://localhost/altiora
DATABASE_SSL=disable
PUBLIC_BASE_URL=http://localhost:3000
EOF
bun run build                                 # constrói dist/ (servidor + aplicação web)
bun run seed:demo                             # cria 2 restaurantes de demonstração (mostra as palavras-passe UMA vez)
bun run start                                 # http://localhost:3000
```

As tabelas e as regras de segurança criam-se sozinhas ao arrancar (`AUTO_MIGRATE`). Todas as variáveis de ambiente estão explicadas em
[`.env.example`](.env.example).

| Comando | O que faz |
|---|---|
| `bun run build` | Constrói `dist/server.js` e `dist/web/`. A pasta `dist/` vem já construída e testada. |
| `bun run start` | Arranca o servidor já construído. |
| `bun run migrate` | Aplica as migrações da base de dados e verifica a segurança (o servidor também o faz ao arrancar). |
| `bun run seed:demo` | Cria a «Terraza Talatona» (restaurante completo, com equipa e mesas) e a «Casa Aurora» (montra da página comercial). |
| `bun run seed:aurora` | Cria só a «Casa Aurora» (é o que se usa em produção; ou use `SEED_SHOWCASE=true`). |
| `bun run test` | Testes automáticos (unitários e com base de dados). Precisa de `TEST_ADMIN_DATABASE_URL`, por exemplo `postgres://postgres@127.0.0.1:5432/postgres`. |
| `bun run test:e2e` | Ensaios de ponta a ponta num navegador a sério (telemóvel simulado). Precisa do Playwright com Chromium e de Node.js 20+. |
| `bun run typecheck` | Verificação dos tipos do TypeScript. |

## Estrutura das pastas

```
dist/        a aplicação já construída (guardada de propósito: o alojamento não precisa de construir nada)
db/          migrações SQL (tabelas, RLS, planos, assinaturas)
server/      o servidor: módulos por tema (pedidos, menu, mesas, planos, plataforma…), site/ (página comercial), testes
shared/      o que servidor e aplicação partilham: regras dos pedidos, planos, QR Codes, validações
web/         a aplicação web: customer/ (cliente), staff/ (painéis), viewer/ (3D e AR), landing/ (página comercial)
web/vendor/  Three.js copiado sem alterações (licença MIT)
scripts/     construção, migrações, dados de demonstração e as imagens e modelos 3D de demonstração
e2e/         ensaios de ponta a ponta
docs/        guias em português
```

## Estado do projeto (o que foi e o que não foi testado)

Foi testado: o servidor e a base de dados (regras de segurança, pedidos, planos, página comercial, ficheiros, relatórios) com testes
automáticos, e os ecrãs num navegador Chromium com telemóvel simulado (cliente, «Chamar o garçom», cozinha, empregado, gerente, Altiora, página comercial, 3D).

**Não foi testado** (e por isso não se declara como funcionando): a publicação real no Render e no Supabase; a imagem Docker; a realidade
aumentada em telemóveis e iPhones verdadeiros; a execução com mais de uma instância do servidor. A lista completa e honesta está em
[`docs/arquitetura.md`](docs/arquitetura.md#o-que-não-foi-testado-e-limites-conhecidos).

## Licenças

O código do projeto é da Altiora Grupo. Os componentes de terceiros (Three.js, React, fflate, zod, tipo de letra Lora, Bun) e as respetivas
licenças estão em [`docs/licencas.md`](docs/licencas.md).
