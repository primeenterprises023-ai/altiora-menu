# Licenças de terceiros

O código do ALTIORA MENU (pastas `server/`, `shared/`, `web/src/`, `scripts/`, `e2e/`, `db/`) é da **Altiora Grupo**.
O sistema usa os componentes abaixo, todos de código aberto, com licenças que permitem uso comercial. **Quem distribui o sistema tem de manter estes avisos** (já vão incluídos).

## O que vai para quem usa o sistema (navegador e servidor)

| Componente | Versão | Licença | Onde está / aviso |
|---|---|---|---|
| **Three.js** (3D) | r187 | MIT | Cópia em `web/vendor/three/` (sem alterações; texto da licença em `web/vendor/three/LICENSE`). O aviso também segue junto do código publicado, em `dist/web/assets/*.LEGAL.txt`. |
| **fflate** (compressão, usada para criar o ficheiro de realidade aumentada no iPhone) | 0.8.3 | MIT | Dentro do Three.js (`web/vendor/three/examples/jsm/libs/fflate.module.js`); aviso em `dist/web/assets/*.LEGAL.txt`. |
| **React** e **React DOM** (a aplicação web) | 19.2.8 | MIT, Meta Platforms, Inc. e afiliadas | Incluídos no código publicado; aviso em `dist/web/assets/*.LEGAL.txt`. |
| **Scheduler** (parte do React) | 0.27.0 | MIT, Meta Platforms, Inc. e afiliadas | Idem. |
| **zod** (validação de dados) | 3.25.76 | MIT | Incluído em `dist/server.js`. |
| **Lora** (tipo de letra dos títulos) | 3.008 | **SIL Open Font License 1.1** | `web/src/styles/lora-var.woff`. Texto completo em `docs/licencas/OFL-1.1-Lora.txt`. Ver a nota abaixo. |
| **Bun** (onde o servidor corre) | 1.x | MIT (inclui componentes de terceiros com outras licenças, ver bun.sh) | Vem na imagem Docker `oven/bun`. Não é distribuído com este projeto. |

### Nota sobre o tipo de letra Lora
- Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), com o «Reserved Font Name» *Lora*.
- O ficheiro do projeto é uma **versão reduzida** do Lora (só os caracteres necessários, em formato WOFF, com eixo de peso variável). Por ser uma versão modificada, a licença **proíbe usar o nome «Lora»** como nome do tipo de letra;
  por isso o nome interno do ficheiro é **«Altiora Lora»** e a aplicação usa-o com esse nome. O aviso de direitos de autor e a referência à licença **mantêm-se** dentro do ficheiro, como a licença exige.
- O tipo de letra **não pode ser vendido isoladamente**. Pode ser usado no sistema comercial sem problema.
- O resto do texto da aplicação usa os tipos de letra do próprio aparelho (não é descarregado nenhum tipo de letra de outro sítio).

## Só para desenvolver e testar (não são distribuídos)

| Componente | Licença |
|---|---|
| esbuild 0.28.2 (construção) | MIT |
| TypeScript 6.0.3 (verificação dos tipos) | Apache-2.0 |
| Playwright 1.63.0 (ensaios de ponta a ponta) | Apache-2.0 |
| React/ReactDOM `@types` e `csstype` | MIT |

## Conteúdo criado para o projeto

- **QR Codes (norma ISO/IEC 18004) e escritor de PDF:** escritos de raiz para este projeto, sem copiar código de terceiros (`shared/qr.ts`, `server/src/lib/pdf.ts`). Nota: «QR Code» é marca registada da Denso Wave Incorporated; a norma é aberta.
- **Imagens e modelos 3D do restaurante de demonstração («Casa Aurora»):** ilustrações e modelos **gerados por computador** pelos programas em `scripts/demo-media/`. Não há fotografias de terceiros nem modelos descarregados.
  Pertencem à Altiora Grupo. Os pratos e o restaurante são **fictícios**.
- **Marca «ALTIORA MENU», «Digital Dining Experience» e logótipo:** da Altiora Grupo.

## Se acrescentar mais componentes
Antes de usar uma biblioteca, imagem, tipo de letra ou modelo 3D de terceiros, confirme a licença (uso comercial permitido? é preciso indicar o autor?) e acrescente-a a este documento.
Em especial, **fotografias e modelos 3D de pratos reais** que os restaurantes enviem são da responsabilidade de quem os envia: os restaurantes devem ter o direito de os usar.
