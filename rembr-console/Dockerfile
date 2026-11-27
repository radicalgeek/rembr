FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY --chown=node:node server.mjs lib.mjs ./
COPY --chown=node:node public ./public
ENV HOST=127.0.0.1 PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "server.mjs"]
