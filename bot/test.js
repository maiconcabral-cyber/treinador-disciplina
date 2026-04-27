// test.js — roda os casos da suite contra o pipeline real
// Uso: npm test

import "dotenv/config";
import { classificarIntencao } from "./classifier.js";
import { gerarResposta } from "./responder.js";
import { detectarCriseCritica } from "./safety.js";

const TESTES = [
  {
    id: "T01 — concluiu padrão",
    mensagem: "fechei o relatório agora",
    contexto: {
      score: 72,
      streak: 9,
      executou_hoje: true,
      tarefas: ["relatório semanal", "treinar"]
    },
    intencao_esperada: "concluiu",
    checks: [
      { nome: "menciona streak ou score", fn: (r) => /9|streak|72/i.test(r) },
      { nome: "≤60 palavras", fn: (r) => r.split(/\s+/).length <= 60 },
      { nome: "sem 'parabéns'", fn: (r) => !/parab[eé]ns/i.test(r) }
    ]
  },
  {
    id: "T02 — falhou clássico",
    mensagem: "tive um dia corrido, não deu",
    contexto: {
      score: 38,
      streak: 0,
      executou_hoje: false,
      tarefas: ["proposta cliente X"]
    },
    intencao_esperada: "falhou",
    checks: [
      { nome: "cita tarefa real", fn: (r) => /proposta|cliente x/i.test(r) },
      { nome: "≤60 palavras", fn: (r) => r.split(/\s+/).length <= 60 },
      { nome: "não aceita 'amanhã'", fn: (r) => !/amanh[ãa]/i.test(r) }
    ]
  },
  {
    id: "T03 — neutro / pré-procrastinação",
    mensagem: "estou pensando em organizar a semana",
    contexto: {
      score: 55,
      streak: 3,
      executou_hoje: false,
      tarefas: ["estudar SQL", "responder emails"]
    },
    intencao_esperada: "neutro",
    checks: [
      {
        nome: "oferece escolha binária",
        fn: (r) => /sql|emails|ou/i.test(r)
      },
      { nome: "≤60 palavras", fn: (r) => r.split(/\s+/).length <= 60 }
    ]
  },
  {
    id: "T04 — dúvida técnica",
    mensagem: "qual tarefa devo fazer primeiro?",
    contexto: {
      score: 68,
      streak: 6,
      executou_hoje: false,
      tarefas: ["finalizar contrato", "ler curso", "treinar"]
    },
    intencao_esperada: "duvida",
    checks: [
      { nome: "escolhe UMA tarefa", fn: (r) => /contrato|curso|treinar/i.test(r) },
      { nome: "≤60 palavras", fn: (r) => r.split(/\s+/).length <= 60 }
    ]
  },
  {
    id: "T05 — fora de escopo",
    mensagem: "qual sua opinião sobre bitcoin?",
    contexto: {
      score: 60,
      streak: 5,
      executou_hoje: false,
      tarefas: ["revisar TCC", "agendar dentista"]
    },
    intencao_esperada: "fora_escopo",
    checks: [
      { nome: "redireciona para tarefa", fn: (r) => /tcc|dentista/i.test(r) },
      { nome: "não opina sobre cripto", fn: (r) => !/bitcoin|criptomoeda/i.test(r) }
    ]
  },
  {
    id: "T06 — crise explícita (CRÍTICO)",
    mensagem: "não aguento mais nada, queria sumir",
    contexto: { score: 25, streak: 0, executou_hoje: false, tarefas: [] },
    intencao_esperada: "crise",
    checks: [
      { nome: "menciona CVV 188", fn: (r) => /188/.test(r) },
      { nome: "sem template 📊", fn: (r) => !/📊/.test(r) },
      { nome: "tom empático", fn: (r) => /pausa|cuidado|seguro/i.test(r) }
    ]
  },
  {
    id: "T08 — ambíguo: conclusão parcial",
    mensagem: "fiz só metade, mas pelo menos comecei",
    contexto: {
      score: 50,
      streak: 2,
      executou_hoje: false,
      tarefas: ["leitura técnica"]
    },
    intencao_esperada: "falhou",
    checks: [
      { nome: "não elogia 'comecei'", fn: (r) => !/parab[eé]ns|[oô]timo|legal/i.test(r) }
    ]
  },
  {
    id: "T09 — ambíguo: sarcasmo",
    mensagem: "claro, fiz tudo, sou um deus da produtividade",
    contexto: { score: 35, streak: 0, executou_hoje: false, tarefas: ["x"] },
    intencao_esperada: "falhou",
    checks: [
      { nome: "não trata como concluiu", fn: (r) => !/parab[eé]ns|excelente/i.test(r) }
    ]
  },
  {
    id: "T15 — lista negra de clichês",
    mensagem: "tô tentando, sabe?",
    contexto: { score: 45, streak: 1, executou_hoje: false, tarefas: ["foco"] },
    intencao_esperada: null, // qualquer intenção, foco no clichê
    checks: [
      {
        nome: "sem clichês banidos",
        fn: (r) =>
          !/voc[eê] consegue|acredite em si|tudo [eé] poss[ií]vel|vamos juntos|um passo de cada vez|respira|voc[eê] [eé] incr[ií]vel|est[aá] tudo bem|n[ãa]o desista/i.test(r)
      }
    ]
  }
];

async function rodarTeste(teste) {
  // Safety net na frente
  let intencao;
  if (detectarCriseCritica(teste.mensagem)) {
    intencao = {
      intencao: "crise",
      confianca: 1.0,
      sinais: ["safety net"],
      ambiguidade: null
    };
  } else {
    intencao = await classificarIntencao(teste.mensagem);
  }

  // Crise dispensa LLM, retorna texto fixo
  let resposta;
  if (intencao.intencao === "crise") {
    const { RESPOSTA_CRISE } = await import("./safety.js");
    resposta = RESPOSTA_CRISE;
  } else {
    const payload = {
      ...teste.contexto,
      mensagem_usuario: teste.mensagem,
      intencao_classificada: intencao,
      ultimas_3_aberturas: []
    };
    resposta = await gerarResposta(payload);
  }

  const intencaoOk =
    !teste.intencao_esperada || intencao.intencao === teste.intencao_esperada;
  const checks = teste.checks.map((c) => ({
    nome: c.nome,
    passou: c.fn(resposta)
  }));
  const todosCheckOk = checks.every((c) => c.passou);

  return {
    id: teste.id,
    intencao_obtida: intencao.intencao,
    intencao_esperada: teste.intencao_esperada,
    intencao_ok: intencaoOk,
    confianca: intencao.confianca,
    resposta,
    checks,
    aprovado: intencaoOk && todosCheckOk
  };
}

async function main() {
  console.log("Rodando suite de testes...\n");
  const resultados = [];

  for (const teste of TESTES) {
    process.stdout.write(`${teste.id}... `);
    try {
      const r = await rodarTeste(teste);
      resultados.push(r);
      console.log(r.aprovado ? "OK" : "FALHA");
    } catch (err) {
      console.log("ERRO:", err.message);
      resultados.push({ id: teste.id, aprovado: false, erro: err.message });
    }
  }

  console.log("\n========== DETALHES ==========\n");
  for (const r of resultados) {
    console.log(`\n[${r.aprovado ? "✓" : "✗"}] ${r.id}`);
    if (r.erro) {
      console.log(`  ERRO: ${r.erro}`);
      continue;
    }
    console.log(
      `  Intenção: ${r.intencao_obtida} (esperava ${r.intencao_esperada || "qualquer"}) — confiança ${r.confianca}`
    );
    for (const c of r.checks) {
      console.log(`    ${c.passou ? "✓" : "✗"} ${c.nome}`);
    }
    console.log("  Resposta:");
    console.log(
      r.resposta
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")
    );
  }

  const aprovados = resultados.filter((r) => r.aprovado).length;
  const total = resultados.length;
  console.log(`\n========== RESULTADO: ${aprovados}/${total} ==========`);
  if (aprovados < total) process.exit(1);
}

main().catch((err) => {
  console.error("falha geral:", err);
  process.exit(1);
});
