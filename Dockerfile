FROM node:22

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

RUN useradd -m envisalink
RUN mkdir -p /data && chown -R envisalink:envisalink /data /app

USER envisalink

ENV NODE_ENV=production
EXPOSE 8192
CMD ["node", "src/index.js"]
