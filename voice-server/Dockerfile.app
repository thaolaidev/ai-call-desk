FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# pg = อ่านคำบรรยายใต้รูปจากฐานข้อมูลแชท (เปิดเมื่อตั้ง CAPTION_DB_URL)
RUN npm init -y >/dev/null && npm i --omit=dev pg@8 >/dev/null
COPY app/server.mjs ./
CMD ["node", "server.mjs"]
