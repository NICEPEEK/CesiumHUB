FROM node:20-slim

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем код приложения
COPY . .

# Создаём папку для базы данных (будет смонтирована в Volume)
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]