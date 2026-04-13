/**
 * advogadoChat.js
 * Chat privado entre Dr. Wanderson e a IA via #chat no WhatsApp
 *
 * Comandos disponíveis:
 *   #chat <pergunta livre>          — IA responde com contexto geral
 *   #chat cliente <telefone>        — histórico + resumo de um cliente
 *   #chat analisar <telefone>       — análise profunda do caso
 *   #chat orientar <instrução>      — IA aprende e salva orientação
 *   #chat agenda                    — ver compromissos do dia/semana
 *   #chat agendar <desc> <data>     — criar compromisso
 *   #chat ajuda                     — lista de comandos
 */

const logger = require('../utils/logger');
const db = require('./database');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
            temperature: 0.4
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq error ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

// ─── Buscar contexto completo de um cliente ───────────────────────────────────

async function buscarContextoCliente(telefone) {
    try {
        // Normaliza telefone
        const tel = telefone.replace(/\D/g, '');

        // Cliente
        const clienteRes = await db.query(
            `SELECT id, nome, telefone, created_at FROM clientes WHERE telefone = $1`,
            [tel]
        );
        if (clienteRes.rows.length === 0) return null;
        const cliente = clienteRes.rows[0];

        // Conversas
        const convsRes = await db.query(
            `SELECT id, status, ultimo_estado, transferido_para_humano, created_at, updated_at
             FROM conversations WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [cliente.id]
        );

        // Últimas 30 mensagens da conversa mais recente
        let mensagens = [];
        if (convsRes.rows.length > 0) {
            const convId = convsRes.rows[0].id;
            const msgsRes = await db.query(
                `SELECT sender, conteudo, tipo, timestamp FROM messages
                 WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT 30`,
                [convId]
            );
            mensagens = msgsRes.rows.reverse();
        }

        // Documentos
        const docsRes = await db.query(
            `SELECT filename_original, tipo_documento, created_at FROM documentos
             WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [cliente.id]
        );

        // Processos
        const procRes = await db.query(
            `SELECT numero_processo, tipo_acao, status, created_at FROM processos
             WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [cliente.id]
        ).catch(() => ({ rows: [] }));

        // Orientações aprendidas sobre este cliente
        const orientRes = await db.query(
            `SELECT conteudo, created_at FROM orientacoes_ia
             WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [cliente.id]
        ).catch(() => ({ rows: [] }));

        return {
            cliente,
            conversas: convsRes.rows,
            mensagens,
            documentos: docsRes.rows,
            processos: procRes.rows,
            orientacoes: orientRes.rows
        };
    } catch (err) {
        logger.error('Erro ao buscar contexto cliente', { error: err.message });
        return null;
    }
}

// ─── Formatar contexto para a IA ──────────────────────────────────────────────

function formatarContextoParaIA(ctx) {
    const { cliente, conversas, mensagens, documentos, processos, orientacoes } = ctx;

    let texto = `=== CLIENTE: ${cliente.nome} (${cliente.telefone}) ===\n`;
    texto += `Cadastrado em: ${new Date(cliente.created_at).toLocaleDateString('pt-BR')}\n\n`;

    if (processos.length > 0) {
        texto += `PROCESSOS:\n`;
        processos.forEach(p => {
            texto += `  • ${p.numero_processo} — ${p.tipo_acao} — ${p.status}\n`;
        });
        texto += '\n';
    }

    if (documentos.length > 0) {
        texto += `DOCUMENTOS RECEBIDOS:\n`;
        documentos.forEach(d => {
            texto += `  • ${d.filename_original} (${d.tipo_documento}) — ${new Date(d.created_at).toLocaleDateString('pt-BR')}\n`;
        });
        texto += '\n';
    }

    if (orientacoes.length > 0) {
        texto += `ORIENTAÇÕES DO ADVOGADO SOBRE ESTE CLIENTE:\n`;
        orientacoes.forEach(o => {
            texto += `  • ${o.conteudo}\n`;
        });
        texto += '\n';
    }

    if (conversas.length > 0) {
        const conv = conversas[0];
        texto += `ÚLTIMA CONVERSA:\n`;
        texto += `  Status: ${conv.status} | Estado: ${conv.ultimo_estado || 'ativo'}\n`;
        texto += `  Transferida para advogado: ${conv.transferido_para_humano ? 'sim' : 'não'}\n\n`;
    }

    if (mensagens.length > 0) {
        texto += `HISTÓRICO RECENTE (últimas ${mensagens.length} mensagens):\n`;
        mensagens.forEach(m => {
            const quem = m.sender === 'customer' ? 'CLIENTE' :
                         m.sender === 'bot' ? 'BOT' :
                         m.sender === 'advogado' ? 'DR. WANDERSON' : 'SISTEMA';
            const hora = new Date(m.timestamp).toLocaleString('pt-BR');
            if (m.tipo !== 'image_context') {
                texto += `[${hora}] ${quem}: ${m.conteudo}\n`;
            }
        });
    }

    return texto;
}

// ─── Salvar orientação aprendida ──────────────────────────────────────────────

async function salvarOrientacao(conteudo, clienteId = null) {
    try {
        // Garantir tabela existe
        await db.query(`
            CREATE TABLE IF NOT EXISTS orientacoes_ia (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL,
                conteudo TEXT NOT NULL,
                ativa BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await db.query(
            `INSERT INTO orientacoes_ia (cliente_id, conteudo) VALUES ($1, $2)`,
            [clienteId || null, conteudo]
        );

        logger.info('Orientação salva', { clienteId, conteudo: conteudo.substring(0, 80) });
        return true;
    } catch (err) {
        logger.error('Erro ao salvar orientação', { error: err.message });
        return false;
    }
}

// ─── Buscar orientações gerais para injetar no system prompt ─────────────────

async function buscarOrientacoesGerais() {
    try {
        const res = await db.query(
            `SELECT conteudo FROM orientacoes_ia
             WHERE cliente_id IS NULL AND ativa = TRUE
             ORDER BY created_at DESC LIMIT 20`
        );
        return res.rows.map(r => r.conteudo);
    } catch {
        return [];
    }
}

// ─── Processar histórico do chat do advogado ──────────────────────────────────

async function buscarHistoricoChat(limite = 10) {
    try {
        const res = await db.query(
            `SELECT remetente, conteudo, created_at FROM chat_advogado
             ORDER BY created_at DESC LIMIT $1`,
            [limite]
        );
        return res.rows.reverse();
    } catch {
        return [];
    }
}

async function salvarMensagemChat(remetente, conteudo) {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS chat_advogado (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                remetente VARCHAR(20) NOT NULL,
                conteudo TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(
            `INSERT INTO chat_advogado (remetente, conteudo) VALUES ($1, $2)`,
            [remetente, conteudo]
        );
    } catch (err) {
        logger.error('Erro ao salvar mensagem do chat', { error: err.message });
    }
}

// ─── PROCESSADOR PRINCIPAL ────────────────────────────────────────────────────

async function processarChatAdvogado(mensagemOriginal) {
    const texto = mensagemOriginal.replace(/^#chat\s*/i, '').trim();
    const lower = texto.toLowerCase();

    // ── AJUDA ────────────────────────────────────────────────────────────────
    if (!texto || lower === 'ajuda' || lower === 'help') {
        return `🤖 *Comandos disponíveis:*

*Consultas:*
• \`#chat cliente 5599xxxxx\` — histórico completo de um cliente
• \`#chat analisar 5599xxxxx\` — análise aprofundada do caso

*Orientações (IA aprende):*
• \`#chat orientar <instrução>\` — ex: "sempre perguntar número do processo antes de consultar"

*Agenda:*
• \`#chat agenda\` — compromissos de hoje e amanhã
• \`#chat agenda semana\` — toda a semana
• \`#chat agendar <descrição> | <data/hora>\` — criar compromisso
  ex: \`#chat agendar Audiência João Silva | 28/03 14h\`

*Geral:*
• \`#chat <qualquer pergunta>\` — converse livremente com a IA
• \`#chat ajuda\` — esta lista`;
    }

    // ── AGENDA — VER ─────────────────────────────────────────────────────────
    if (lower.startsWith('agenda')) {
        const agendaService = require('./agendaService');
        const semana = lower.includes('semana');
        return await agendaService.listarCompromissos(semana ? 7 : 2);
    }

    // ── AGENDA — CRIAR ───────────────────────────────────────────────────────
    if (lower.startsWith('agendar ')) {
        const agendaService = require('./agendaService');
        const partes = texto.substring(8).split('|').map(s => s.trim());
        if (partes.length < 2) {
            return '❌ Formato: `#chat agendar <descrição> | <data/hora>`\nEx: `#chat agendar Audiência João | 28/03 14h`';
        }
        return await agendaService.criarCompromisso(partes[0], partes[1]);
    }

    // ── ORIENTAR — IA aprende ────────────────────────────────────────────────
    if (lower.startsWith('orientar ')) {
        const instrucao = texto.substring(9).trim();
        if (!instrucao) return '❌ Informe a orientação. Ex: `#chat orientar sempre verificar número do processo`';

        const salvo = await salvarOrientacao(instrucao);
        await salvarMensagemChat('advogado', mensagemOriginal);
        await salvarMensagemChat('ia', `✅ Orientação registrada e ativa.`);

        return `✅ *Orientação registrada!*\n\n"${instrucao}"\n\nVou aplicar isso nas próximas conversas com clientes.`;
    }

    // ── CLIENTE — histórico ──────────────────────────────────────────────────
    if (lower.startsWith('cliente ')) {
        const telefone = texto.substring(8).trim().replace(/\D/g, '');
        if (!telefone) return '❌ Informe o telefone. Ex: `#chat cliente 5599982277074`';

        const ctx = await buscarContextoCliente(telefone);
        if (!ctx) return `❌ Cliente com telefone *${telefone}* não encontrado no sistema.`;

        const contextoFormatado = formatarContextoParaIA(ctx);
        const orientacoes = await buscarOrientacoesGerais();

        const systemPrompt = `Você é um assistente jurídico do Dr. Wanderson Mailson Machado Lopes, OAB MA-00000.
Apresente de forma clara e organizada o histórico e situação atual do cliente.
Destaque pontos importantes, pendências e próximos passos recomendados.
${orientacoes.length > 0 ? '\nOrientações do advogado:\n' + orientacoes.map(o => `• ${o}`).join('\n') : ''}`;

        const resposta = await groqChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Apresente o resumo e situação do seguinte cliente:\n\n${contextoFormatado}` }
        ], 2000);

        await salvarMensagemChat('advogado', mensagemOriginal);
        await salvarMensagemChat('ia', resposta);
        return resposta;
    }

    // ── ANALISAR — análise profunda ──────────────────────────────────────────
    if (lower.startsWith('analisar ')) {
        const telefone = texto.substring(9).trim().replace(/\D/g, '');
        if (!telefone) return '❌ Informe o telefone. Ex: `#chat analisar 5599982277074`';

        const ctx = await buscarContextoCliente(telefone);
        if (!ctx) return `❌ Cliente não encontrado: *${telefone}*`;

        const contextoFormatado = formatarContextoParaIA(ctx);
        const orientacoes = await buscarOrientacoesGerais();

        const systemPrompt = `Você é um assistente jurídico especializado do Dr. Wanderson Mailson Machado Lopes.
Faça uma análise profunda do caso, incluindo:
1. Situação atual e histórico relevante
2. Pontos de atenção e riscos identificados
3. Documentos recebidos e os que ainda faltam
4. Recomendações de próximos passos
5. Sugestão de estratégia jurídica
Seja objetivo e direto. Use linguagem jurídica adequada.
${orientacoes.length > 0 ? '\nOrientações do advogado:\n' + orientacoes.map(o => `• ${o}`).join('\n') : ''}`;

        const resposta = await groqChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Analise profundamente este caso:\n\n${contextoFormatado}` }
        ], 3000);

        await salvarMensagemChat('advogado', mensagemOriginal);
        await salvarMensagemChat('ia', resposta);
        return resposta;
    }

    // ── CONVERSA LIVRE ────────────────────────────────────────────────────────
    const historico = await buscarHistoricoChat(10);
    const orientacoes = await buscarOrientacoesGerais();

    const messages = [
        {
            role: 'system',
            content: `Você é um assistente jurídico inteligente do Dr. Wanderson Mailson Machado Lopes, OAB MA-00000, Imperatriz-MA.
Ajude com análises jurídicas, estratégias de casos, redação de documentos, pesquisa legal e gestão do escritório.
Seja preciso, objetivo e use linguagem jurídica adequada quando necessário.
${orientacoes.length > 0 ? '\nOrientações e preferências do Dr. Wanderson:\n' + orientacoes.map(o => `• ${o}`).join('\n') : ''}`
        }
    ];

    // Adicionar histórico do chat
    historico.forEach(m => {
        messages.push({
            role: m.remetente === 'advogado' ? 'user' : 'assistant',
            content: m.conteudo
        });
    });

    messages.push({ role: 'user', content: texto });

    const resposta = await groqChat(messages, 2000);

    await salvarMensagemChat('advogado', texto);
    await salvarMensagemChat('ia', resposta);

    return resposta;
}

module.exports = {
    processarChatAdvogado,
    buscarOrientacoesGerais,
    salvarOrientacao,
    buscarContextoCliente,
    formatarContextoParaIA
};