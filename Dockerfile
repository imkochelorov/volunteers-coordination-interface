FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4319 \
    DATABASE_PATH=/app/data/app.sqlite
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4319
CMD ["node", "server.js"]
