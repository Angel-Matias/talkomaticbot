const { io } = require("socket.io-client");
require("dotenv").config();

const SERVER_URL = "https://classic.talkomatic.co";
const BOT_TOKEN = process.env.BOT_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const ROOM_ID = process.env.ROOM_ID;

const socket = io(SERVER_URL, {
  auth: { token: BOT_TOKEN },
  transports: ["websocket"],
  reconnection: true,
});

let myUsername = null;
let isInRoom = false;

const messageQueue = [];
let isProcessing = false;
const processedMessages = {};

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;

  const { username, location, text, timestamp } = messageQueue.shift();
  console.log(`⏳ Procesando mensaje de ${username} (${new Date(timestamp).toLocaleTimeString()}): ${text}`);

  try {
    const reply = await askAI(username, location, text);
    if (reply) {
      console.log("🤖 Respondiendo:", reply);
      const chunks = reply.match(/.{1,200}/g) || [];
      for (const chunk of chunks) {
        socket.emit("chat update", {
          diff: { type: "full-replace", text: chunk }
        });
        await new Promise(r => setTimeout(r, 300));
      }

      if (messageQueue.length > 0) {
        console.log(`📋 Hay ${messageQueue.length} mensaje(s) en cola, borrando en 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        socket.emit("chat update", {
          diff: { type: "full-replace", text: "" }
        });
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.log("📭 Cola vacía, dejando respuesta visible...");
      }
    }
  } catch (err) {
    console.error("❌ Error consultando IA:", err.message);
  }

  isProcessing = false;
  processQueue();
}

const originalOnevent = socket.onevent;
socket.onevent = function(packet) {
  const eventName = packet.data?.[0];
  if (eventName !== "lobby update") {
    console.log("📨 Evento recibido:", JSON.stringify(packet.data));
  }
  originalOnevent.call(this, packet);
};

socket.on("connect", () => {
  console.log("✅ Conectado a Talkomatic");
  socket.emit("join lobby", { username: "GeminiBot", location: "Servidor Ángel" });
});

socket.on("connect_error", (err) => {
  console.error("❌ Error de conexión:", err.message);
});

socket.on("disconnect", (reason) => {
  console.warn("⚠️ Desconectado:", reason);
  isInRoom = false;
});

socket.on("signin status", (data) => {
  console.log("📋 signin status:", JSON.stringify(data, null, 2));
  if (data.isSignedIn) {
    myUsername = data.username;
    console.log(`Firmado como ${myUsername}`);
    if (!isInRoom) {
      isInRoom = true;
      console.log(`📤 Uniéndose a sala ${ROOM_ID}...`);
      socket.emit("join room", { roomId: ROOM_ID });
    }
  } else {
    console.log("❌ No está firmado:", JSON.stringify(data, null, 2));
  }
});

socket.on("room joined", (data) => {
  console.log("✅ room joined:", JSON.stringify(data, null, 2));
});

socket.on("room error", (data) => {
  console.error("❌ Error de sala:", JSON.stringify(data, null, 2));
  isInRoom = false;
});

socket.on("error", (data) => {
  console.error("❌ Socket error:", JSON.stringify(data, null, 2));
});

socket.on("chat update", (data) => {
  if (data.username === myUsername) return;

  const msg = data.diff?.text || "";
  const username = data.username;
  const lower = msg.trim().toLowerCase();

  const startsWithAI = lower.startsWith("/ai ");
  const endsWithEnd = lower.endsWith(" /end") || lower.endsWith("/end");

  if (startsWithAI && endsWithEnd) {
    let cleanText = msg.trim().slice(3).trim();
    const lastEnd = cleanText.toLowerCase().lastIndexOf("/end");
    cleanText = cleanText.slice(0, lastEnd).trim();

    if (!cleanText) return;

    const messageKey = `${username}:${cleanText}`;
    if (processedMessages[messageKey]) return;
    processedMessages[messageKey] = true;
    setTimeout(() => { delete processedMessages[messageKey]; }, 30000);

    console.log(`📥 Mensaje confirmado de ${username}: "${cleanText}"`);
    messageQueue.push({
      username,
      location: data.location || "?",
      text: cleanText,
      timestamp: Date.now()
    });
    console.log(`📋 Cola: ${messageQueue.length} mensaje(s) pendiente(s)`);
    processQueue();
  }
});

socket.on("afk warning", () => {
  socket.emit("afk response");
});

async function askAI(username, location, text) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CF_API_TOKEN}`
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "You are a female chat bot on Talkomatic. Respond naturally and briefly, like a real girl chatting. Ignore spam or nonsense text. Maximum 2 sentences. Always write in English."
          },
          {
            role: "user",
            content: `${username} / ${location}: ${text}`
          }
        ],
        max_tokens: 150,
        temperature: 0.7,
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudflare AI HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data?.result?.response?.trim() || null;
}
