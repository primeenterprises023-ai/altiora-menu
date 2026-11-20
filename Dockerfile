# ALTIORA MENU — imagem de produção (é a que o Render usa).
#
# A aplicação já vem construída na pasta dist/ (é reconstruída e testada antes de cada entrega), por isso esta imagem
# não instala nada da internet: só precisa do Bun, de dist/, das migrações da base de dados e das imagens e modelos 3D
# do restaurante de demonstração. Não usa node_modules.
#
# Experimentar no seu computador (precisa de Docker e de uma base de dados PostgreSQL):
#   docker build -t altiora-menu .
#   docker run --rm -p 3000:3000 --env-file .env altiora-menu
FROM oven/bun:1-slim

ENV NODE_ENV=production \
    WEB_DIR=./dist/web \
    MIGRATIONS_DIR=./db/migrations \
    DEMO_MEDIA_DIR=./scripts/demo-media/assets

WORKDIR /app
COPY --chown=bun:bun dist ./dist
COPY --chown=bun:bun db/migrations ./db/migrations
COPY --chown=bun:bun scripts/demo-media/assets ./scripts/demo-media/assets

# o servidor corre sem privilégios de administrador
USER bun

# O Render indica a porta na variável PORT (e ignora esta linha); sozinho, o servidor usa a 3000.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "dist/server.js"]
