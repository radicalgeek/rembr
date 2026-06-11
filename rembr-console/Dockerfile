FROM node:20-alpine
WORKDIR /app
COPY server.mjs lib.mjs ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
