import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cron from "node-cron";

import { detectarCriseCritica, RESPOSTA_CRISE } from "./bot/safety.js";
import { classificarIntencao } from "./bot/classifier.js";
import {
  gerarResposta,
  extrairAbertura,
  formatarParaTelegram
} from "./bot/responder.js";
import {
  getUser,
  updateUser,
  pushAbertura,
  addTarefas,
  marcarTarefasFeitas,
  descartarTarefa,
  reabrirTarefa,
  getTarefasPendentes,
  getTarefasFinalizadasNoIntervalo,
  deslocarData,
  listarChatIds
} from "./bot/storage.js";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const CHECKIN_CRON = process.env.CHECKIN_CRON || "0 8 * * *"; // 8h no fuso TIMEZONE

// ---------------- Helpers ----------------

function hoje() {
  return new Date().toISOString().split("T")[0];
}

async function enviarTelegram(chatId, texto, html = false) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    ...(html ? { parse_mode: "HTML" } : {})
  });
}

function enriquecerPendentes(pendentes) {
  const hojeData = new Date(hoje());
  return pendentes.map((t, i) => {
    const criada = new Date(t.criadaEm);
    const idade = Math.max(
      0,
      Math.round((hojeData - criada) / (1000 * 60 * 60 * 24))
    );
    return { n: i + 1, texto: t.texto, idade_dias: idade };
  });
}

function formatarPendentes(enriquecidas) {
  if (!enriquecidas.length) return "";
  return enriquecidas
    .map((t) => {
      const idade = t.idade_dias > 0 ? ` (${t.idade_dias}d parada)` : "";
      return `${t.n}. ${t.texto}${idade}`;
    })
    .join("\n");
}

// Reset diário: se mudou de dia, atualiza streak/score
function resetDiarioSeNecessario(user, userId) {
  const hojeData = hoje();
  if (user.ultimo_check === hojeData) return user;

  const updates = { ultimo_check: hojeData };
  if (user.executou_hoje) {
    updates.streak = (user.streak || 0) + 1;
  } else if (user.ultimo_check !== null) {
    updates.streak = 0;
    updates.score = Math.max((user.score || 50) - 5, 0);
  }
  updates.executou_hoje = false;
  return updateUser(userId, updates);
}

// Comandos diretos (sem LLM). Retorna true se tratou.
async function tratarComando(chatId, userText) {
  const t = userText.trim().toLowerCase();

  if (t === "pendentes" || t === "/pendentes" || t === "lista") {
    const pendentes = getTarefasPendentes(chatId, 3);
    if (!pendentes.length) {
      await enviarTelegram(chatId, "Sem pendentes nos últimos 3 dias.");
    } else {
      const enriquecidas = enriquecerPendentes(pendentes);
      await enviarTelegram(
        chatId,
        `Pendentes:\n${formatarPendentes(enriquecidas)}`
      );
    }
    return true;
  }

  // Descartar tarefa: "descarta 2" / "descartar relatório"
  const mDescarta = t.match(/^descart[ar]+\s+(.+)$/);
  if (mDescarta) {
    const arg = mDescarta[1].trim();
    const seletor = /^\d+$/.test(arg) ? Number(arg) : arg;
    const { descartada } = descartarTarefa(chatId, seletor);
    if (descartada) {
      await enviarTelegram(
        chatId,
        `Descartada: "${descartada.texto}". Foco no que sobrou.`
      );
    } else {
      await enviarTelegram(chatId, "Não achei essa pendência.");
    }
    return true;
  }

  // "reabrir tudo" / "reabrir todas" / "errei tudo" → desfaz todas finalizadas hoje
  if (
    /^(reabr[ae]?[ir]?\s+(tudo|todas?))|errei\s+(tudo|todas?)$/i.test(t)
  ) {
    const hojeStr = hoje();
    const finalizadasHoje = getTarefasFinalizadasNoIntervalo(
      chatId,
      hojeStr,
      hojeStr
    );
    let count = 0;
    for (let i = 0; i < finalizadasHoje.length; i++) {
      const r = reabrirTarefa(chatId, 1);
      if (r.reaberta) count++;
    }
    if (count > 0) {
      await enviarTelegram(
        chatId,
        `Reabri ${count} ${count === 1 ? "tarefa" : "tarefas"} de hoje. Pendentes restauradas.`
      );
    } else {
      await enviarTelegram(chatId, "Nada finalizado hoje pra reabrir.");
    }
    return true;
  }

  // Reabrir tarefa marcada por engano: "reabrir 1" / "reabre 1" / "reabrir relatório"
  const mReabrir = t.match(/^reabr[ae]?[ir]?\s+(.+)$/);
  if (mReabrir) {
    const arg = mReabrir[1].trim();
    const seletor = /^\d+$/.test(arg) ? Number(arg) : arg;
    const { reaberta } = reabrirTarefa(chatId, seletor);
    if (reaberta) {
      await enviarTelegram(
        chatId,
        `Reaberta: "${reaberta.texto}". Voltou pras pendentes.`
      );
    } else {
      await enviarTelegram(
        chatId,
        "Não achei nenhuma tarefa finalizada com isso. Manda o número (a 1 é a mais recente)."
      );
    }
    return true;
  }

  // "Errei" / "errado" / "desfaz" → reabre a última finalizada
  if (t === "errei" || t === "errado" || t === "desfaz" || t === "desfazer") {
    const { reaberta } = reabrirTarefa(chatId, 1);
    if (reaberta) {
      await enviarTelegram(
        chatId,
        `Reaberta: "${reaberta.texto}". Se foi mais de uma, manda "reabrir 2", "reabrir 3"...`
      );
    } else {
      await enviarTelegram(chatId, "Nada finalizado pra reabrir.");
    }
    return true;
  }

  // "manter" / "msm" / "essas msm" / "as mesmas" / "essas 3" / "essas mesmas"
  // → confirma que o usuário vai continuar nas pendentes existentes
  if (
    /^(msm|mesm[ao]s?|as mesm[ao]s?|essas msm|essas mesm[ao]s?|essas 3 msm|essas tr[eê]s|manter|mant[eé]m|continua[r]?|sigo nessas|essas mesmas|essas 3)$/i.test(
      t
    )
  ) {
    const pendentes = getTarefasPendentes(chatId, 3);
    if (!pendentes.length) {
      await enviarTelegram(
        chatId,
        "Não tem pendentes pra manter. Manda suas 3 tarefas de hoje."
      );
      return true;
    }
    const enriquecidas = enriquecerPendentes(pendentes);
    await enviarTelegram(
      chatId,
      `Beleza, foco nessas. Bora pela #1: "${enriquecidas[0].texto}". Quando terminar, manda "feito 1".`
    );
    return true;
  }

  if (t === "checkin" || t === "/checkin" || t === "bom dia") {
    await enviarCheckIn(chatId);
    return true;
  }

  if (t === "/start" || t === "start" || t === "começar" || t === "comecar") {
    await enviarTelegram(
      chatId,
      [
        "Tô on. Todo dia 8h te chamo pras 3 tarefas do dia.",
        "",
        "Comandos:",
        "• \"feito 1\" / \"ok 2 e 3\" — marca como concluída",
        "• \"pendentes\" — lista o que tá em aberto",
        "• \"descarta 2\" — zera uma pendência",
        "• \"reabrir 1\" / \"errei\" — desfaz a última marcada",
        "• \"manter\" / \"msm\" — continua nas pendentes (não cria novas)",
        "• \"bom dia\" / \"checkin\" — força o check-in fora do horário"
      ].join("\n")
    );
    return true;
  }

  return false;
}

// Monta e envia o check-in das 8h
async function enviarCheckIn(chatId) {
  const pendentes = getTarefasPendentes(chatId, 3);
  const enriquecidas = enriquecerPendentes(pendentes);

  let msg;
  if (enriquecidas.length) {
    msg = `Bom dia. Pendentes dos últimos 3 dias:\n${formatarPendentes(
      enriquecidas
    )}\n\nQuais suas 3 tarefas pra hoje? Manda numeradas (1, 2, 3).`;
  } else {
    msg = "Bom dia. Quais suas 3 tarefas pra hoje? Manda numeradas (1, 2, 3).";
  }

  await enviarTelegram(chatId, msg);
  console.log({
    evento: "checkin_enviado",
    chatId,
    pendentes: enriquecidas.length
  });
}

// ---------------- Webhook ----------------

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userText = message.text;

    console.log("📩", chatId, userText);

    // 1. Pega user e roda reset diário
    let user = getUser(chatId);
    user = resetDiarioSeNecessario(user, chatId);

    // 2. Comandos diretos primeiro (sem LLM)
    if (await tratarComando(chatId, userText)) {
      return res.sendStatus(200);
    }

    // 3. Safety net de crise (keyword, antes do LLM)
    if (detectarCriseCritica(userText)) {
      await enviarTelegram(chatId, RESPOSTA_CRISE);
      updateUser(chatId, {
        em_modo_seguro: true,
        ultima_classificacao_crise: new Date().toISOString()
      });
      console.log({
        evento: "crise_detectada",
        chatId,
        mensagem: userText,
        sinais: ["palavra-chave"]
      });
      return res.sendStatus(200);
    }

    // 4. Classifier (Haiku)
    const intencao = await classificarIntencao(userText);

    // 5. Crise via LLM → resposta fixa
    if (intencao.intencao === "crise") {
      await enviarTelegram(chatId, RESPOSTA_CRISE);
      updateUser(chatId, {
        em_modo_seguro: true,
        ultima_classificacao_crise: new Date().toISOString()
      });
      console.log({
        evento: "crise_detectada",
        chatId,
        mensagem: userText,
        sinais: intencao.sinais
      });
      return res.sendStatus(200);
    }

    // 6. Atalho: declarou_tarefas → salva e confirma sem LLM
    if (
      intencao.intencao === "declarou_tarefas" &&
      intencao.tarefas_extraidas?.length
    ) {
      const lista = intencao.tarefas_extraidas;
      addTarefas(chatId, lista);
      const primeira = lista[0];
      await enviarTelegram(
        chatId,
        `Anotado: ${lista.length} ${
          lista.length === 1 ? "tarefa" : "tarefas"
        }. Bora pela #1: "${primeira}". Quando terminar, manda "feito 1".`
      );
      console.log({
        evento: "tarefas_declaradas",
        chatId,
        quantidade: lista.length
      });
      return res.sendStatus(200);
    }

    // 7. Atalho: concluiu_especifica → marca e devolve próxima pendente
    if (
      intencao.intencao === "concluiu_especifica" &&
      intencao.indices_concluidos?.length
    ) {
      const { user: userPos, marcadas } = marcarTarefasFeitas(
        chatId,
        intencao.indices_concluidos
      );
      if (marcadas.length === 0) {
        await enviarTelegram(
          chatId,
          "Não achei a tarefa. Manda \"pendentes\" pra ver a lista."
        );
        return res.sendStatus(200);
      }
      updateUser(chatId, {
        executou_hoje: true,
        score: Math.min(100, (userPos.score || 50) + 10 * marcadas.length)
      });
      const restantes = getTarefasPendentes(chatId, 3);
      const proxima = restantes[0];
      const nomes = marcadas.map((m) => `"${m.texto}"`).join(", ");
      const tail = proxima
        ? `Próxima: "${proxima.texto}".`
        : "Lista zerada hoje.";
      await enviarTelegram(chatId, `Feito: ${nomes}. ${tail}`);
      console.log({
        evento: "concluiu_especifica",
        chatId,
        marcadas: marcadas.map((m) => m.texto)
      });
      return res.sendStatus(200);
    }

    // 8. Ajuste de score genérico por intenção
    if (intencao.intencao === "concluiu") {
      user = updateUser(chatId, {
        executou_hoje: true,
        score: Math.min(100, (user.score || 50) + 10)
      });
    } else if (intencao.intencao === "falhou") {
      user = updateUser(chatId, {
        score: Math.max(0, (user.score || 50) - 10)
      });
    }

    // 9. Payload novo pro responder
    const pendentes = getTarefasPendentes(chatId, 3);
    const enriquecidas = enriquecerPendentes(pendentes);
    const pendentesHoje = enriquecidas.filter((t) => t.idade_dias === 0);
    const pendentesAtrasadas = enriquecidas.filter((t) => t.idade_dias > 0);

    const hojeStr = hoje();
    const ontemStr = deslocarData(hojeStr, -1);
    const finalizadasHoje = getTarefasFinalizadasNoIntervalo(
      chatId,
      hojeStr,
      hojeStr
    );
    const finalizadasOntem = getTarefasFinalizadasNoIntervalo(
      chatId,
      ontemStr,
      ontemStr
    );

    const historico = {
      hoje: {
        feitas: finalizadasHoje
          .filter((t) => t.status === "feita")
          .map((t) => t.texto),
        descartadas: finalizadasHoje
          .filter((t) => t.status === "descartada")
          .map((t) => t.texto)
      },
      ontem: {
        feitas: finalizadasOntem
          .filter((t) => t.status === "feita")
          .map((t) => t.texto),
        descartadas: finalizadasOntem
          .filter((t) => t.status === "descartada")
          .map((t) => t.texto)
      }
    };

    const payload = {
      score: user.score,
      streak: user.streak,
      executou_hoje: user.executou_hoje,
      pendentes_hoje: pendentesHoje,
      pendentes_atrasadas: pendentesAtrasadas,
      historico,
      mensagem_usuario: userText,
      intencao: intencao.intencao,
      confianca: intencao.confianca,
      ambiguidade: intencao.ambiguidade,
      ultimas_3_aberturas: user.ultimas_3_aberturas || []
    };

    // 10. Responder (Sonnet)
    const reply = await gerarResposta(payload);

    // 11. Persiste abertura (anti-repetição) — como o template novo não tem "Diagnóstico:",
    // pega a primeira linha não-vazia.
    const abertura =
      extrairAbertura(reply) ||
      reply.split("\n").map((l) => l.trim()).find(Boolean);
    pushAbertura(chatId, abertura);

    // 12. Envia
    await enviarTelegram(chatId, formatarParaTelegram(reply), true);

    // 13. Log
    console.log({
      evento: "resposta_enviada",
      chatId,
      intencao: intencao.intencao,
      confianca: intencao.confianca,
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

// ---------------- Cron de check-in 8h ----------------

cron.schedule(
  CHECKIN_CRON,
  async () => {
    const ids = listarChatIds();
    console.log({ evento: "cron_disparado", total_chats: ids.length });
    for (const chatId of ids) {
      try {
        await enviarCheckIn(chatId);
      } catch (err) {
        console.error("cron: falha ao enviar check-in", chatId, err.message);
      }
    }
  },
  { timezone: TIMEZONE }
);

// Health check
app.get("/", (req, res) => {
  res.send("Bot rodando 🚀");
});

app.listen(3000, () => {
  console.log("🚀 Servidor rodando na porta 3000");
  console.log(`⏰ Check-in agendado: ${CHECKIN_CRON} (${TIMEZONE})`);
});
