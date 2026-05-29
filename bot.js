const { io } = require("socket.io-client");

const SERVER_URL = "https://classic.talkomatic.co";
const BOT_TOKEN = "tk_0c37ae4c5e6f3c2b28f616d84e87437b521d3b868822e532608e2454c2a597ea";
const OPENROUTER_API_KEY = "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";
const ROOM_ID = "517801";

// ✅ Modelos gratuitos actualizados Mayo 2026
const MODELS = [
  "openrouter/auto",                           // elige automáticamente el mejor free
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat:free",
  "qwen/qwen3-8b:free",
  "nvidia/llama-3.1-nemotron-nano-8b-v1:free",
];

const socket = io(SERVER_URL, {
  auth: { token: BOT_TOKEN },
  transports: ["websocket"],
  reconnection: true,
});

let myUsername = null;
let isInRoom = false;
const userBuffers = {};
const TYPING_TIMEOUT = 2000;

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

  if (!msg.trim()) {
    if (userBuffers[username]) {
      clearTimeout(userBuffers[username].timer);
      const finalText = userBuffers[username].text.trim();
      delete userBuffers[username];
      if (finalText) {
        console.log(`💬 Mensaje enviado por ${username}: ${finalText}`);
        handleMessage(username, data.location || "?", finalText);
      }
    }
    return;
  }

  if (!userBuffers[username]) {
    userBuffers[username] = { text: "", location: data.location || "?", timer: null };
  }

  userBuffers[username].text = msg;
  userBuffers[username].location = data.location || "?";

  clearTimeout(userBuffers[username].timer);
  userBuffers[username].timer = setTimeout(() => {
    const finalText = userBuffers[username]?.text.trim();
    delete userBuffers[username];
    if (finalText) {
      console.log(`💬 Mensaje completo de ${username}: ${finalText}`);
      handleMessage(username, data.location || "?", finalText);
    }
  }, TYPING_TIMEOUT);
});

socket.on("afk warning", () => {
  socket.emit("afk response");
});

async function handleMessage(username, location, text) {
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
    }
  } catch (err) {
    console.error("❌ Error consultando IA:", err.message);
  }
}

async function askAI(username, location, text) {
  for (const model of MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://talkomatic.co",
          "X-Title": "TalkomaticBot"
        },
        body: JSON.stringify({
          model,
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
      });

      if (res.status === 429) {
        console.warn(`⚠️ ${model} rate limited, probando siguiente...`);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`⚠️ Error con ${model}: ${errText}`);
        continue;
      }

      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) {
        console.log(`✅ Respondió con modelo: ${model}`);
        return reply;
      }

    } catch (err) {
      console.warn(`⚠️ Error con ${model}:`, err.message);
    }
  }

  console.error("❌ Todos los modelos fallaron");
  return null;
}
