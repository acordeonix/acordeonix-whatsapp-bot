// Acordeonix — Agente de WhatsApp (Cloud API de Meta + Claude + Firestore)
// Requisitos: Node 18+  ->  npm install
// Variables de entorno: ver .env.example

import express from "express";
import crypto from "crypto";
import admin from "firebase-admin";

const {
  WA_TOKEN,                     // Token permanente del System User
  WA_PHONE_NUMBER_ID,           // Phone Number ID de Meta
  WA_VERIFY_TOKEN,              // Texto que tú inventas para verificar el webhook
  META_APP_SECRET,              // App Secret para validar la firma de Meta
  ANTHROPIC_API_KEY,
  HANDOFF_NUMBER,               // Tu número (formato 5216641234567)
  FIREBASE_SERVICE_ACCOUNT_B64, // JSON de la cuenta de servicio, en base64
  PAUSA_HORAS = "4",            // Horas que el bot se calla cuando entra un humano
  COEXISTENCIA = "false",       // "true" si tu número está en la app Y en la API
  PORT = 3000,
} = process.env;

const GRAPH_VERSION = "v23.0"; // revisa la versión vigente en developers.facebook.com
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
const MAX_TURNOS = 12;
const PAUSA_MS = Number(PAUSA_HORAS) * 3600 * 1000;

// ---------- Firebase ----------
// En Cloud Run/Firebase puedes omitir la variable y usa las credenciales por defecto.
if (FIREBASE_SERVICE_ACCOUNT_B64) {
  const sa = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8"));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} else {
  admin.initializeApp();
}
const db = admin.firestore();

// Estructura:
//   wa_chats/{telefono}                 -> { nombre, pausadoHasta, actualizado }
//   wa_chats/{telefono}/mensajes/{auto} -> { role, content, autor, ts }
//   wa_procesados/{messageId}           -> evita duplicados (Meta reintenta)
const chatRef = (tel) => db.collection("wa_chats").doc(tel);

// ---------- Conocimiento del negocio ----------
// Reglas fijas; los datos, FAQs y ejemplos vienen de Firestore: config/conocimiento
// (se genera con extraer_conocimiento.js y se sube con subir_conocimiento.js)
const REGLAS_BASE = `
Eres el asistente de ventas y soporte de ACORDEONIX, acordeones MIDI hechos a mano en Tijuana.
Contesta SOLO temas de Acordeonix: modelos, precios, afinaciones, envíos, garantía, app y pedidos.
Si te preguntan algo fuera del negocio, redirige amablemente.
Responde breve, en el idioma del cliente, con el mismo estilo con el que contesta el equipo.
Usa ÚNICAMENTE los datos de abajo. Nunca inventes precios, fechas ni características.
Si el cliente quiere comprar, pregunta algo que no está en los datos, o pide hablar con una persona,
responde normalmente y agrega al final exactamente la etiqueta [HUMANO].
`.trim();

let kbCache = { texto: null, hasta: 0 };
async function systemPrompt() {
  if (kbCache.texto && Date.now() < kbCache.hasta) return kbCache.texto;
  const kb = (await db.doc("config/conocimiento").get()).data() || {};
  const partes = [REGLAS_BASE];
  if (kb.descripcion_estilo) partes.push(`ESTILO DEL EQUIPO:\n${kb.descripcion_estilo}`);
  if (kb.hechos?.length) partes.push("DATOS DEL NEGOCIO (fuente de verdad):\n" +
    kb.hechos.map((h) => `- [${h.tema}] ${h.dato}`).join("\n"));
  if (kb.faqs?.length) partes.push("PREGUNTAS FRECUENTES:\n" +
    kb.faqs.map((f) => `P: ${f.pregunta}\nR: ${f.respuesta}`).join("\n\n"));
  if (kb.objeciones_frecuentes?.length) partes.push("OBJECIONES Y CÓMO LAS MANEJA EL EQUIPO:\n" +
    kb.objeciones_frecuentes.map((o) => `- ${o.objecion}: ${o.como_responde}`).join("\n"));
  if (kb.ejemplos?.length) partes.push("EJEMPLOS REALES DE BUENAS RESPUESTAS:\n" +
    kb.ejemplos.map((e) => `<ejemplo>\nCliente: ${e.cliente}\nEquipo: ${e.respuesta}\n</ejemplo>`).join("\n"));
  kbCache = { texto: partes.join("\n\n"), hasta: Date.now() + 5 * 60 * 1000 }; // 5 min
  return kbCache.texto;
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// 1) Verificación del webhook
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// 2) Eventos entrantes
app.post("/webhook", async (req, res) => {
  if (!firmaValida(req)) return res.sendStatus(401);
  res.sendStatus(200);

  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      try {
        if (change.field === "smb_message_echoes") {
          // Tú escribiste desde la app de WhatsApp Business (coexistencia)
          for (const echo of change.value?.message_echoes || []) await procesarEcho(echo);
        } else {
          const value = change.value;
          for (const msg of value?.messages || []) await procesarMensaje(msg, value);
        }
      } catch (err) {
        console.error("Error procesando evento:", err);
      }
    }
  }
});

// Mensaje que TÚ mandaste desde la app: se guarda y el bot se pausa con ese cliente
async function procesarEcho(echo) {
  if (await yaProcesado(echo.id)) return;
  const cliente = echo.to;
  const texto = echo.type === "text" ? echo.text?.body : `[${echo.type} enviado desde la app]`;
  await guardarMensaje(cliente, "assistant", texto, "humano");
  await pausar(cliente, PAUSA_MS); // cada mensaje tuyo renueva la pausa
  console.log(`Humano atendiendo a +${cliente}, bot en pausa ${PAUSA_HORAS} h`);
}

// Mensaje de un cliente
async function procesarMensaje(msg, value) {
  if (await yaProcesado(msg.id)) return;

  const de = msg.from;
  const nombre = value.contacts?.[0]?.profile?.name || "";
  const texto = msg.type === "text" ? msg.text.body.trim() : null;

  // Comandos desde tu número (útiles si NO usas coexistencia)
  if (de === HANDOFF_NUMBER && texto?.startsWith("/")) return manejarComando(texto);

  if (!texto) {
    await guardarMensaje(de, "user", `[${msg.type}]`, "cliente", { nombre });
    if (!(await enPausa(de))) {
      await marcarLeido(msg.id);
      await enviarTexto(de, "¡Gracias! Por ahora solo puedo leer texto. ¿Me escribes tu pregunta?");
    }
    return;
  }

  await guardarMensaje(de, "user", texto, "cliente", { nombre });

  if (await enPausa(de)) {
    // Con coexistencia ya lo ves en tu app; sin ella, te lo reenvía
    if (COEXISTENCIA !== "true") {
      await avisar(`💬 ${nombre} (+${de}):\n"${texto}"\nResponde con: /r ${de} tu mensaje`);
    }
    return; // sin marcar leído, para que te aparezca como no leído en la app
  }

  await marcarLeido(msg.id);
  const respuesta = await preguntarClaude(await cargarHistorial(de));
  const necesitaHumano = respuesta.includes("[HUMANO]");
  const limpia = respuesta.replace("[HUMANO]", "").trim();

  await guardarMensaje(de, "assistant", limpia, "bot");
  await enviarTexto(de, limpia);

  if (necesitaHumano) {
    await db.collection("preguntas_sin_respuesta").add({ tel: de, pregunta: texto, ts: Date.now(), revisada: false });
    await pausar(de, PAUSA_MS);
    const comoResponder = COEXISTENCIA === "true"
      ? "Contéstale directo desde la app."
      : `Responder: /r ${de} tu mensaje`;
    await avisar(
      `🔔 Atender a ${nombre} (+${de}):\n"${texto}"\n\n` +
      `Bot en pausa ${PAUSA_HORAS} h para este cliente.\n${comoResponder}\nReactivar bot: /activar ${de}`
    );
  }
}

// ---------- Comandos ----------
//   /r <numero> <texto>   -> le contestas al cliente a través del bot
//   /pausa <numero>       -> el bot se calla con ese cliente
//   /activar <numero>     -> el bot vuelve a contestar
async function manejarComando(texto) {
  const [cmd, numero, ...resto] = texto.split(/\s+/);
  if (!numero) return avisar("Uso: /r <numero> <texto> | /pausa <numero> | /activar <numero>");

  if (cmd === "/r") {
    const cuerpo = resto.join(" ");
    if (!cuerpo) return avisar("Falta el texto. Ej: /r 5216641234567 Hola, soy Jonathan");
    await enviarTexto(numero, cuerpo);
    await guardarMensaje(numero, "assistant", cuerpo, "humano");
    await pausar(numero, PAUSA_MS);
    return avisar(`✅ Enviado a +${numero}`);
  }
  if (cmd === "/pausa") {
    await pausar(numero, PAUSA_MS);
    return avisar(`⏸️ Bot en pausa ${PAUSA_HORAS} h con +${numero}`);
  }
  if (cmd === "/activar") {
    await pausar(numero, 0);
    return avisar(`▶️ Bot activo de nuevo con +${numero}`);
  }
  return avisar("Comando no reconocido.");
}

// ---------- Firestore ----------
async function yaProcesado(id) {
  try {
    await db.collection("wa_procesados").doc(id).create({ ts: Date.now() });
    return false;
  } catch (e) {
    if (e.code === 6) return true; // ALREADY_EXISTS
    throw e;
  }
}

async function guardarMensaje(tel, role, content, autor, extra = {}) {
  const ts = Date.now();
  await chatRef(tel).collection("mensajes").add({ role, content, autor, ts });
  await chatRef(tel).set({ ...extra, actualizado: ts }, { merge: true });
}

async function cargarHistorial(tel) {
  const snap = await chatRef(tel).collection("mensajes")
    .orderBy("ts", "desc").limit(MAX_TURNOS).get();
  const msgs = snap.docs.map((d) => d.data()).reverse()
    .map(({ role, content }) => ({ role, content }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // Claude exige empezar con user
  return msgs;
}

async function enPausa(tel) {
  const chat = (await chatRef(tel).get()).data() || {};
  return (chat.pausadoHasta || 0) > Date.now();
}

async function pausar(tel, ms) {
  await chatRef(tel).set({ pausadoHasta: ms ? Date.now() + ms : 0 }, { merge: true });
}

// ---------- Claude ----------
async function preguntarClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      // cache_control abarata el prompt largo en mensajes seguidos
      system: [{ type: "text", text: await systemPrompt(), cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  const data = await r.json();
  return data.content?.find((b) => b.type === "text")?.text
    || "Disculpa, tuve un problema. En un momento te atiende una persona. [HUMANO]";
}

// ---------- WhatsApp ----------
// México: WhatsApp manda los celulares como 521XXXXXXXXXX, pero la API
// espera 52XXXXXXXXXX para enviar. Se quita el "1" solo al enviar.
const normalizarMX = (n) => String(n).replace(/\D/g, "").replace(/^521(\d{10})$/, "52$1");

async function enviarTexto(to, body) {
  to = normalizarMX(to);
  const r = await fetch(GRAPH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  if (!r.ok) console.error(`Error al enviar a ${to}:`, await r.text());
}

const avisar = (texto) => HANDOFF_NUMBER && enviarTexto(HANDOFF_NUMBER, texto);

async function marcarLeido(message_id) {
  await fetch(GRAPH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id }),
  });
}

function firmaValida(req) {
  if (!META_APP_SECRET) return true; // solo en pruebas
  const firma = req.get("x-hub-signature-256") || "";
  const esperado = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  return firma.length === esperado.length &&
    crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperado));
}

app.listen(PORT, () => console.log(`Bot Acordeonix escuchando en :${PORT}`));
