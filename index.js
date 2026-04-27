import express from "express";
import axios from "axios";
import dotenv from "dotenv";

import { detectarCriseCritica, RESPOSTA_CRISE } from "./bot/safety.js";
import { classificarIntencao } from "./bot/classifier.js";
import {
  gerarResposta,
  extrairAbertura,
  formatarParaTelegram
} from "./bot/responder.js";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

// 🔥 MEMÓRIA (em-memória; sobrevive enquanto o processo rodar)
const memoria = {};

// Helpers
function hoje() {
  return new Date().toISOString().split("T")[0];
}

function getUser(chatId) {
  if (!memoria[chatId]) {
    memoria[chatId] = {
      score: 50,
      streak: 0,
      ultimoCheck: null,
      executouHoje: false,
      tarefas: [],
      ultimas_3_aberturas: [],
      em_modo_seguro: false,
      ultima_classificacao_crise: null
    };
  }
  return memoria[chatId];
}

function pushAbertura(user, abertura) {
  if (!abertura) return;
  user.ultimas_3_aberturas = [...(user.ultimas_3_aberturas || []), abertura].slice(-3);
}

async function enviarTelegram(chatId, texto, html = false) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    ...(html ? { parse_mode: "HTML" } : {})
  });
}

// 🔥 WEBHOOK
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userText = message.text;
    const userTextLower = userText.toLowerCase();

    console.log("📩", userText);

    const user = getUser(chatId);
    const hojeData = hoje();

    // 🔥 RESET DIÁRIO (mantido da sua versão)
    if (user.ultimoCheck !== hojeData) {
      if (user.executouHoje) {
        user.streak += 1;
      } else if (user.ultimoCheck !== null) {
        user.streak = 0;
        user.score = Math.max(user.score - 5, 0);
      }
      user.executouHoje = false;
      user.ultimoCheck = hojeData;
    }

    // 🔥 AJUSTE DE SCORE POR PALAVRA-CHAVE (mantido da sua versão)
    if (
      userTextLower.includes("concluí") ||
      userTextLower.includes("finalizei") ||
      userTextLower.includes("terminei") ||
      userTextLower.includes("fechei") ||
      userTextLower.includes("fiz")
    ) {
      user.score = Math.min(user.score + 10, 100);
      user.executouHoje = true;
    } else if (
      userTextLower.includes("não fiz") ||
      userTextLower.includes("nao fiz") ||
      userTextLower.includes("não consegui") ||
      userTextLower.includes("nao consegui") ||
      userTextLower.includes("depois faço") ||
      userTextLower.includes("depois faco")
    ) {
      user.score = Math.max(user.score - 10, 0);
    } else if (
      userTextLower.includes("depois") ||
      userTextLower.includes("mais tarde")
    ) {
      user.score = Math.max(user.score - 5, 0);
    }

    // 🔥 1. SAFETY NET — detecta crise por keyword antes de qualquer LLM
    let intencaoClassificada;
    if (detectarCriseCritica(userText)) {
      intencaoClassificada = {
        intencao: "crise",
        confianca: 1.0,
        sinais: ["palavra-chave de crise"],
        ambiguidade: null
      };
      user.em_modo_seguro = true;
      user.ultima_classificacao_crise = new Date().toISOString();
    } else {
      // 🔥 2. CLASSIFICADOR (Haiku, ~10x mais barato que Sonnet)
      intencaoClassificada = await classificarIntencao(userText);
    }

    // 🔥 3. CRISE → atalho que dispensa o responder
    if (intencaoClassificada.intencao === "crise") {
      await enviarTelegram(chatId, RESPOSTA_CRISE);
      console.log({
        evento: "crise_detectada",
        chatId,
        mensagem: userText,
        sinais: intencaoClassificada.sinais
      });
      return res.sendStatus(200);
    }

    // 🔥 4. PAYLOAD COMPLETO PARA O RESPONDER
    const payload = {
      score: user.score,
      streak: user.streak,
      executou_hoje: user.executouHoje,
      tarefas: user.tarefas,
      mensagem_usuario: userText,
      intencao_classificada: intencaoClassificada,
      ultimas_3_aberturas: user.ultimas_3_aberturas || [],
      em_modo_seguro: user.em_modo_seguro || false
    };

    // 🔥 5. RESPONDER (Sonnet)
    const reply = await gerarResposta(payload);

    // 🔥 6. PERSISTE A NOVA ABERTURA (anti-repetição)
    const abertura = extrairAbertura(reply);
    pushAbertura(user, abertura);

    // 🔥 7. ENVIA AO TELEGRAM (HTML pra formatar bold)
    await enviarTelegram(chatId, formatarParaTelegram(reply), true);

    // 🔥 8. LOG ESTRUTURADO
    console.log({
      evento: "resposta_enviada",
      chatId,
      intencao: intencaoClassificada.intencao,
      confianca: intencaoClassificada.confianca,
      score: user.score,
      streak: user.streak,
      tamanho_palavras: reply.split(/\s+/).length
    });

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ ERRO:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Bot rodando 🚀");
});

app.listen(3000, () => {
  console.log("🚀 Servidor rodando na porta 3000");
});
