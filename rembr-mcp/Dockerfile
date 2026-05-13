FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Copy UI templates (needed at runtime)
COPY src/ui-resources/templates ./dist/ui-resources/templates

# Remove dev dependencies
RUN npm prune --production

# Copy and apply patches AFTER npm prune
COPY patches ./patches
RUN npx patch-package

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run the server
CMD ["node", "dist/index-http.js"]
