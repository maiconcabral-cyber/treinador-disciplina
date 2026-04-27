// index.js — entrada do bot do Telegram
// Pipeline: mensagem → safety net → classifier → responder → telegram

import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";

import { detectarCriseCritica, RESPOSTA_CRISE } from "./safety.js";
import { classificarIntencao } from "./classifier.js";
import {
  gerarResposta,
  extrairAbertura,
  formatarParaTelegram
} from "./responder.js";
import {
  getUser,
  updateUser,
  pushAbertura,
  addTarefa,
  removerTarefa,
  marcarExecutado
} from "./storage.js";

if (!process.env.TELEGRAM_TOKEN) {
  console.error("ERRO: TELEGRAM_TOKEN não definido no .env");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERRO: ANTHROPIC_API_KEY não definido no .env");
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// ============== COMANDOS ==============

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Aqui não tem motivação genérica. Só execução.\n\nUse /add <tarefa> para registrar uma tarefa.\nUse /listar para ver suas tarefas.\nUse /feito quando executar.\nUse /ajuda se precisar de apoio real.\n\nMe conte o que você fez (ou não fez) hoje."
  );
});

bot.onText(/^\/ajuda/, (msg) => {
  bot.sendMessage(msg.chat.id, RESPOSTA_CRISE);
});

bot.onText(/^\/add (.+)/, (msg, match) => {
  const tarefa = match[1].trim();
  const user = addTarefa(msg.chat.id, tarefa);
  bot.sendMessage(
    msg.chat.id,
    `Tarefa registrada: "${tarefa}"\nTotal: ${user.tarefas.length}`
  );
});

bot.onText(/^\/listar/, (msg) => {
  const user = getUser(msg.chat.id);
  if (!user.tarefas.length) {
    return bot.sendMessage(
      msg.chat.id,
      "Nenhuma tarefa registrada. Use /add <tarefa>."
    );
  }
  const lista = user.tarefas
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
  bot.sendMessage(
    msg.chat.id,
    `Tarefas:\n${lista}\n\nUse /remover <número> para apagar.`
  );
});

bot.onText(/^\/remover (\d+)/, (msg, match) => {
  const idx = parseInt(match[1], 10) - 1;
  removerTarefa(msg.chat.id, idx);
  bot.sendMessage(msg.chat.id, "Tarefa removida.");
});

bot.onText(/^\/feito/, (msg) => {
  const user = marcarExecutado(msg.chat.id, true);
  bot.sendMessage(
    msg.chat.id,
    `Registrado. Streak: ${user.streak} | Score: ${user.score}`
  );
});

bot.onText(/^\/zerar/, (msg) => {
  const user = marcarExecutado(msg.chat.id, false);
  bot.sendMessage(
    msg.chat.id,
    `Streak zerado. Score: ${user.score}`
  );
});

bot.onText(/^\/status/, (msg) => {
  const user = getUser(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    `Score: ${user.score}\nStreak: ${user.streak}\nExecutou hoje: ${user.executou_hoje ? "sim" : "não"}\nTarefas: ${user.tarefas.length}`
  );
});

// ============== HANDLER PRINCIPAL ==============

bot.on("message", async (msg) => {
  const userId = String(msg.chat.id);
  const texto = msg.text;

  // Ignora comandos (já tratados acima) e mensagens não-texto
  if (!texto || texto.startsWith("/")) return;

  try {
    // 1. SAFETY NET — detecta crise por keyword antes de qualquer LLM
    let intencaoClassificada;
    if (detectarCriseCritica(texto)) {
      intencaoClassificada = {
        intencao: "crise",
        confianca: 1.0,
        sinais: ["palavra-chave de crise"],
        ambiguidade: null
      };
      updateUser(userId, {
        em_modo_seguro: true,
        ultima_classificacao_crise: new Date().toISOString()
      });
    } else {
      intencaoClassificada = await classificarIntencao(texto);
    }

    // 2. CRISE — atalho que dispensa o responder
    if (intencaoClassificada.intencao === "crise") {
      await bot.sendMessage(msg.chat.id, RESPOSTA_CRISE);
      console.log({
        evento: "crise_detectada",
        userId,
        mensagem: texto,
        sinais: intencaoClassificada.sinais
      });
      return;
    }

    // 3. PAYLOAD COMPLETO
    const user = getUser(userId);
    const payload = {
      score: user.score,
      streak: user.streak,
      executou_hoje: user.executou_hoje,
      tarefas: user.tarefas,
      mensagem_usuario: texto,
      intencao_classificada: intencaoClassificada,
      ultimas_3_aberturas: user.ultimas_3_aberturas || [],
      em_modo_seguro: user.em_modo_seguro || false
    };

    // 4. RESPONDER
    const resposta = await gerarResposta(payload);

    // 5. PERSISTE NOVA ABERTURA (para anti-repetição)
    const abertura = extrairAbertura(resposta);
    if (abertura) pushAbertura(userId, abertura);

    // 6. ENVIA AO TELEGRAM (HTML para formatar bold)
    await bot.sendMessage(
      msg.chat.id,
      formatarParaTelegram(resposta),
      { parse_mode: "HTML" }
    );

    // 7. LOG ESTRUTURADO PARA AUDITORIA
    console.log({
      evento: "resposta_enviada",
      userId,
      intencao: intencaoClassificada.intencao,
      confianca: intencaoClassificada.confianca,
      tamanho_palavras: resposta.split(/\s+/).length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("handler: erro", err);
    await bot.sendMessage(
      msg.chat.id,
      "Erro técnico. Tenta de novo em 1 minuto."
    );
  }
});

bot.on("polling_error", (err) => {
  console.error("polling_error:", err.message);
});

console.log("Disciplinador rodando. CTRL+C para parar.");
