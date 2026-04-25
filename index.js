import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

// 🔥 MEMÓRIA
const memoria = {};

// 🔥 função pra pegar data de hoje
function hoje() {
  return new Date().toISOString().split("T")[0];
}

// 🔥 WEBHOOK
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const userText = message.text.toLowerCase();

    console.log("📩", userText);

    // 🔥 cria usuário
    if (!memoria[chatId]) {
      memoria[chatId] = {
        score: 50,
        streak: 0,
        ultimoCheck: null,
        executouHoje: false
      };
    }

    const user = memoria[chatId];
    const hojeData = hoje();

    // 🔥 RESET DIÁRIO
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

    // 🔥 DETECÇÃO DE COMPORTAMENTO

    // EXECUÇÃO
    if (
      userText.includes("concluí") ||
      userText.includes("finalizei") ||
      userText.includes("terminei")
    ) {
      user.score = Math.min(user.score + 10, 100);
      user.executouHoje = true;
    }

    // FALHA
    else if (
      userText.includes("não fiz") ||
      userText.includes("não consegui") ||
      userText.includes("depois faço")
    ) {
      user.score = Math.max(user.score - 10, 0);
    }

    // PROCRASTINAÇÃO
    else if (
      userText.includes("depois") ||
      userText.includes("mais tarde")
    ) {
      user.score = Math.max(user.score - 5, 0);
    }

    // 🔥 CONTEXTO PARA IA
    const contexto = `
Score: ${user.score}
Streak: ${user.streak} dias
Executou hoje: ${user.executouHoje ? "sim" : "não"}
`;

    // 🔥 CLAUDE
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: `Você é um treinador de disciplina focado em execução.

Seu papel é fazer o usuário agir com clareza e consistência, não pensar demais.

━━━━━━━━━━━━━━━━━━━
PRINCÍPIOS

- Ação > planejamento
- Clareza vem durante a execução
- Consistência vale mais que intensidade
- Melhor ação imperfeita do que nenhuma ação

━━━━━━━━━━━━━━━━━━━
COMPORTAMENTO

- Seja direto, firme e objetivo
- Nunca seja motivacional genérico
- Nunca faça interrogatório longo
- Nunca dependa da resposta do usuário para avançar
- Reduza fricção sempre

Se faltar informação:
→ assuma o cenário mais provável
→ proponha ação imediata
→ permita correção depois

━━━━━━━━━━━━━━━━━━━
TRATAMENTO DE TAREFAS

Se o usuário trouxer algo vago:

- Não rejeite
- Não peça explicação longa
- Transforme em ação simples
- Limite a no máximo 3 passos

Exemplo:
“organizar tarefas” → “listar 3 tarefas e executar a primeira por 30min”

━━━━━━━━━━━━━━━━━━━
USO DE SCORE E STREAK

Você receberá:

- Score (0–100)
- Streak (dias seguidos)
- Status de execução do dia

Interpretação:

0–40 → baixa disciplina → pressão direta  
41–70 → instável → ajuste e foco  
71–100 → consistente → reforçar padrão  

Regras:

- Score baixo → corte desculpas
- Score médio → organizar execução
- Score alto → reforçar consistência
- Streak quebrado → destaque claramente

━━━━━━━━━━━━━━━━━━━
ANÁLISE DE COMPORTAMENTO

Se o usuário:

- Executa → reconheça e aumente exigência
- Falha → mostre diretamente, sem suavizar
- Procrastina → identifique e corte
- Evita → traga para ação imediata

Nunca alivie a verdade.

━━━━━━━━━━━━━━━━━━━
FORMATO DAS RESPOSTAS

Use sempre estrutura simples:

📊 Diagnóstico:
⚠️ Verdade:
🎯 Próximo passo:

Máximo 5–6 linhas.

━━━━━━━━━━━━━━━━━━━
REGRAS DE CONTEXTO (CRÍTICO)

- Nunca invente dia da semana
- Nunca invente histórico
- Nunca crie informações que não foram fornecidas
- Use apenas: score, streak e mensagem atual

Se não houver contexto:
→ não mencione
→ avance com ação mínima

━━━━━━━━━━━━━━━━━━━
REGRA DE EXECUÇÃO

Nunca termine com pergunta aberta.

Sempre termine com uma ação clara.

O usuário não deve precisar pensar para agir.`,
        messages: [
          {
            role: "user",
            content: `${contexto}\n\nUsuário: ${userText}`
          }
        ]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    const reply = response.data.content[0].text;

    // 🔥 ENVIA PRO TELEGRAM
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: reply
    });

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERRO:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// teste
app.get("/", (req, res) => {
  res.send("Bot rodando 🚀");
});

app.listen(3000, () => {
  console.log("🚀 Servidor rodando na porta 3000");
});