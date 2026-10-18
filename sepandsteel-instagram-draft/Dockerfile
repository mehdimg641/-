FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    ENABLE_WEBHOOK_RECEIVER=false \
    ENABLE_OUTBOUND_REPLIES=false \
    HOST=0.0.0.0 \
    PORT=3000 \
    DEDUPE_DB_PATH=/data/events.sqlite
WORKDIR /app
COPY --chown=node:node package.json server.js config.js store.js ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
