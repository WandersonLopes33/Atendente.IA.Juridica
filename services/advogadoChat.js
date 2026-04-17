/**
 * advogadoChat.js - VERSÃO COM LÓGICA DE DECISÃO DE BUSCA (AGENTE)
 */

const logger = require('../utils/logger');
const db = require('./database');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ─── FUNÇÃO DE BUSCA WEB (TAVILY) ──────────────────────────────────────────
async function buscarNaWeb(query) {
    if (process.env.WEB_SEARCH_ENABLED !== 'true') return null;
    
    try {
        logger.info('IA solicitou busca para confirmação', { query });
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: query,
                search_depth: "advanced",
                include_answer: true,
                max_results: 3
            })
        });

        const data = await response.json();
        return data.answer || JSON.stringify(data.results);
    } catch (error) {
        logger.error("❌ Erro ao consultar Tavily", { error: error.message });
        return null;
    }
}

// ─── HELPERS DE IA ──────────────────────────────────────────────────────────

async function groqChat(messages, maxTokens = 1500) {
    const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages,
            max_tokens: maxTokens,
            temperature: 0.3 // Temperatura mais baixa para maior precisão
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq error ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

// ─── PROCESSADOR PRINCIPAL COM LÓGICA DE DÚVIDA ───────────────────────────────

async function processarChatAdvogado(mensagemOriginal) {
    const texto = mensagemOriginal.replace(/^#chat\s*/i, '').trim();
    const lower = texto.toLowerCase();

    if (!texto || lower === 'ajuda') {
        return `🤖 *Menu Jurídico:* #chat <pergunta> | #chat cliente <tel> | #chat analisar <tel> | #chat agenda`;
    }

    // ── LÓGICA DE DECISÃO: Pesquisar ou não? ────────────────────────────────
    
    // Primeiro, a IA analisa se a pergunta exige dados externos atualizados
    const decisaoBuscaPrompt = [
        {
            role: 'system',
            content: `Você é um seletor de necessidade de pesquisa. Responda apenas "SIM" se a pergunta do usuário envolver:
            1. Jurisprudência recente ou leis específicas.
            2. Prazos processuais ou notícias jurídicas atuais.
            3. Qualquer tema onde você tenha dúvida técnica.
            Caso contrário (saudações, perguntas sobre o cliente, agenda), responda "NÃO".`
        },
        { role: 'user', content: texto }
    ];

    const precisaPesquisar = await groqChat(decisaoBuscaPrompt, 10);
    let contextoWeb = "";

    if (precisaPesquisar.includes("SIM")) {
        const resultadoBusca = await buscarNaWeb(texto);
        if (resultadoBusca) {
            contextoWeb = `\n\n[CONFIRMAÇÃO WEB (TAVILY)]:\n${resultadoBusca}`;
        }
    }

    // ── BUSCA CONTEXTO DE CLIENTE SE NECESSÁRIO ──────────────────────────────
    let contextoCliente = "";
    if (lower.includes('cliente') || lower.includes('analisar')) {
        const tel = texto.match(/\d{10,13}/)?.[0];
        if (tel) {
            const ctx = await buscarContextoCliente(tel); // Função do arquivo anterior
            if (ctx) contextoCliente = `\n\n[DADOS DO CLIENTE]:\n${formatarContextoParaIA(ctx)}`;
        }
    }

    const orientacoes = await buscarOrientacoesGerais();
    const historico = await buscarHistoricoChat(6);

    // ── RESPOSTA FINAL ───────────────────────────────────────────────────────
    
    const systemPrompt = `Você é o assistente jurídico do Dr. Wanderson Mailson Machado Lopes.
    DIRETRIZ DE OURO: Se houver dúvida sobre uma lei ou procedimento, utilize os dados da WEB fornecidos.
    Seja técnico, mas direto.
    ${orientacoes.length > 0 ? '\nInstruções do Dr. Wanderson:\n' + orientacoes.join('\n') : ''}
    ${contextoWeb}
    ${contextoCliente}`;

    const messages = [{ role: 'system', content: systemPrompt }];
    historico.forEach(m => messages.push({ role: m.remetente === 'advogado' ? 'user' : 'assistant', content: m.conteudo }));
    messages.push({ role: 'user', content: texto });

    const resposta = await groqChat(messages, 2500);

    await salvarMensagemChat('advogado', texto);
    await salvarMensagemChat('ia', resposta);

    return resposta;
}

// (Mantenha as funções auxiliares buscarContextoCliente, formatarContextoParaIA, etc., do código anterior)

module.exports = { processarChatAdvogado };