const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const db = require('../services/database');
const groqAI = require('../services/groqAI');
const evolutionAPI = require('../services/evolutionAPI');
const emailService = require('../services/emailService');
const processoHandler = require('../services/processoWhatsAppHandler');
const conversationTypeDetector = require('../services/conversationTypeDetector');
const processmovementnotifier = require('../services/Processmovementnotifier');
const newcasecollector = require('../services/Newcasecollector');
const documentprocessor = require('../services/Documentprocessor');
const advogadoChat = require('../services/advogadoChat');
const monitoramento = require('../services/monitoramentoSilencioso');

// ── Buffer: agrupa TODAS as mensagens do mesmo número por 2 minutos ──────────
// Textos, imagens e documentos são acumulados juntos.
// A IA só é chamada uma vez, com contexto completo, após 2 minutos de silêncio.
const messageBuffer = {};
const BUFFER_DELAY_MS = 40 * 1000; // 40 segundos

function bufferMessage(phoneNumber, messageText, processFn) {
    if (messageBuffer[phoneNumber]) {
        clearTimeout(messageBuffer[phoneNumber].timer);
        messageBuffer[phoneNumber].messages.push(messageText);
    } else {
        messageBuffer[phoneNumber] = { messages: [messageText] };
    }
    messageBuffer[phoneNumber].timer = setTimeout(async () => {
        const allMessages = messageBuffer[phoneNumber].messages;
        delete messageBuffer[phoneNumber];
        // Filtra entradas vazias (mídias que já foram processadas separado)
        const combined = allMessages.filter(m => m && m.trim()).join('\n');
        logger.info('Buffer processado', { phone: phoneNumber, count: allMessages.length });
        if (combined.trim()) await processFn(combined);
    }, BUFFER_DELAY_MS);
}

// ── Detecção de pedido de e-mail em linguagem natural ─────────────────────────
function detectEmailRequest(text) {
    const lower = text.toLowerCase();
    const patterns = [
        /e-?mail(s)? de hoje/,
        /e-?mail(s)? (de |do |da )?(hoje|ontem|semana|mes)/,
        /(ver|lista|listar|mostrar|checar|verificar|buscar|procurar).{0,20}e-?mail/,
        /e-?mail.{0,20}(novo|recente|n[aã]o lido)/,
        /(tem|chegou|recebi|recebeu).{0,20}e-?mail/,
        /caixa de entrada/,
        /e-?mail(s)? sobre/,
        /e-?mail(s)? d[eo] /,
        /e-?mail(s)? com assunto/,
    ];
    return patterns.some(p => p.test(lower));
}

function parseEmailIntent(text) {
    const lower = text.toLowerCase();
    if (/hoje/.test(lower)) return '#email hoje';
    const fromMatch = lower.match(/e-?mails? d[eo] ([\w.@]+)/);
    if (fromMatch) return `#email de ${fromMatch[1]}`;
    const subjectMatch = lower.match(/assunto[:\s]+([\w\s]+)/);
    if (subjectMatch) return `#email assunto ${subjectMatch[1].trim()}`;
    const searchMatch = lower.match(/(sobre|com|buscar|procurar)[:\s]+([\w\s]+)/);
    if (searchMatch) return `#email buscar ${searchMatch[2].trim()}`;
    return '#email hoje';
}

function isAdvogado(phoneNumber) {
    const notifyPhone = (process.env.EMAIL_NOTIFY_PHONE || '').replace(/\D/g, '');
    return notifyPhone && phoneNumber === notifyPhone;
}

// ── Opt-out via IA: analisa contexto antes de encerrar ───────────────────────
async function detectOptOutComIA(combinedText, historico) {
    try {
        const ultimasMensagens = historico
            .slice(-4)
            .map(m => `[${m.sender === 'customer' ? 'CLIENTE' : 'BOT'}]: ${m.conteudo}`)
            .join('\n');

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: `Voce analisa conversas de WhatsApp de um escritorio de advocacia.
Dado o historico recente e a ultima mensagem do cliente, decida:
O cliente esta claramente encerrando a conversa e nao quer mais ser contactado?

Responda APENAS: "sim" ou "nao"

Exemplos de ENCERRAMENTO: "nao quero mais mensagens", "para de me chamar", "nao obrigada" apos oferta de servico, "chega", "nao preciso"
Exemplos de CONTINUACAO: "ok" apos confirmacao, "entendido", "obrigado", "nao" respondendo pergunta especifica`
                    },
                    {
                        role: 'user',
                        content: `Historico recente:\n${ultimasMensagens}\n\nUltima mensagem do cliente: "${combinedText}"\n\nO cliente quer encerrar?`
                    }
                ],
                max_tokens: 5,
                temperature: 0.1
            })
        });

        if (!response.ok) return false;
        const data = await response.json();
        const resposta = data.choices[0].message.content.trim().toLowerCase();
        return resposta === 'sim';

    } catch {
        return false;
    }
}

// ── Detecção de pedido de transferência via IA ───────────────────────────────
// Retorna: 'transferir' | 'ambiguo' | 'nao'
async function detectTransferenciaComIA(combinedText, historico) {
    try {
        const ultimasMensagens = historico
            .slice(-6)
            .map(m => `[${m.sender === 'customer' ? 'CLIENTE' : 'BOT'}]: ${m.conteudo}`)
            .join('\n');

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: `Voce analisa conversas de um escritorio de advocacia.
O cliente esta conversando com um assistente virtual (bot). O advogado e o Dr. Wanderson Mailson.

Dado o historico e a ultima mensagem, decida se o cliente quer falar DIRETAMENTE com o advogado (nao com o bot).

Responda APENAS uma das tres opcoes:
- "transferir" — cliente claramente quer falar com o advogado/humano
- "ambiguo" — nao esta claro, pode ser pedido de transferencia
- "nao" — cliente nao quer transferencia, quer continuar com o bot

Exemplos de TRANSFERIR: "quero falar com o advogado", "me coloca em contato com o dr wanderson", "preciso falar com uma pessoa", "nao quero mais falar com robo"
Exemplos de AMBIGUO: "tem como falar com alguem?", "posso falar com o responsavel?", "quero uma resposta humana"
Exemplos de NAO: "qual o valor da consulta", "tenho uma duvida", "como funciona"`
                    },
                    {
                        role: 'user',
                        content: `Historico recente:\n${ultimasMensagens}\n\nUltima mensagem do cliente: "${combinedText}"\n\nDecisao:`
                    }
                ],
                max_tokens: 10,
                temperature: 0.1
            })
        });

        if (!response.ok) return 'nao';
        const data = await response.json();
        const resposta = data.choices[0].message.content.trim().toLowerCase();

        if (resposta.includes('transferir')) return 'transferir';
        if (resposta.includes('ambiguo') || resposta.includes('ambíguo')) return 'ambiguo';
        return 'nao';

    } catch {
        return 'nao';
    }
}

// ── Monitoramento pós-transferência: decide se o bot retoma ──────────────────
// Retorna true se a mensagem for profissional/jurídica e o bot deve retomar
async function deveRetomarAposTransferencia(combinedText, historico) {
    try {
        const ultimasMensagens = historico
            .slice(-4)
            .map(m => `[${m.sender === 'customer' ? 'CLIENTE' : 'BOT'}]: ${m.conteudo}`)
            .join('\n');

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: `Voce monitora mensagens de um escritorio de advocacia.
O cliente foi transferido para o advogado humano. Analise a nova mensagem do cliente.

Decida se esta mensagem e um assunto juridico/profissional que o assistente virtual pode resolver (sem precisar do advogado).

Responda APENAS "sim" ou "nao".

Responda "sim" (bot pode retomar) se: duvida juridica geral, pedido de informacao, agendamento, consulta de processo, novo caso
Responda "nao" (manter com advogado) se: mensagem pessoal, resposta a algo que o advogado disse, assunto ja em andamento com o advogado, saudacao simples`
                    },
                    {
                        role: 'user',
                        content: `Historico:\n${ultimasMensagens}\n\nNova mensagem: "${combinedText}"\n\nBot pode retomar?`
                    }
                ],
                max_tokens: 5,
                temperature: 0.1
            })
        });

        if (!response.ok) return false;
        const data = await response.json();
        return data.choices[0].message.content.trim().toLowerCase().includes('sim');

    } catch {
        return false;
    }
}


router.post('/', async (req, res) => {
    try {
        const { event, instance, data } = req.body;

        // ── CORREÇÃO 1: Ignorar connection.update completamente ───────────────
        // O Evolution API dispara esse evento em loop durante reconexão (80+ vezes
        // em 3 segundos nos logs de 07/03). Não tem utilidade no fluxo de atendimento.
        if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
            return res.status(200).json({ success: true });
        }

        logger.info('Webhook recebido', { event, instance });

        if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
            const message = data.key ? data : data.messages?.[0];
            if (!message) return res.status(200).json({ success: true });

            const { key, message: messageContent, pushName } = message;
            const phoneNumber = key.remoteJid.replace('@s.whatsapp.net', '');

            // ── Ignorar grupos ────────────────────────────────────────────────
            if (key.remoteJid.includes('@g.us')) return res.status(200).json({ success: true });

            // ── Mensagens próprias (fromMe) — só salvar se advogado está atendendo ──
            // Quando transferido_para_humano = true, as mensagens que o Dr. Wanderson
            // envia para o cliente chegam com fromMe = true. Salvamos para o histórico.
            if (key.fromMe) {
                const textoAdvogado = messageContent?.conversation ||
                    messageContent?.extendedTextMessage?.text || '';

                if (textoAdvogado && textoAdvogado.trim()) {
                    // Verificar se há conversa ativa transferida para este número
                    (async () => {
                        try {
                            const convRes = await db.query(
                                `SELECT id FROM conversations
                                 WHERE telefone = $1
                                   AND status != 'closed'
                                   AND transferido_para_humano = TRUE
                                 ORDER BY updated_at DESC LIMIT 1`,
                                [phoneNumber]
                            );
                            if (convRes.rows.length > 0) {
                                await monitoramento.processarMensagemMonitorada(
                                    convRes.rows[0].id,
                                    phoneNumber,
                                    textoAdvogado,
                                    'advogado'
                                );
                            }
                        } catch (e) {
                            // Silencioso — não bloquear o fluxo
                        }
                    })();
                }
                return res.status(200).json({ success: true });
            }

            // ── Detectar tipo de mensagem ─────────────────────────────────────
            // Evolution API v2 às vezes encapsula em messageContextInfo
            // Precisamos desempacotar para chegar na mensagem real
            const unwrappedContent = messageContent?.documentWithCaptionMessage?.message
                || messageContent?.ephemeralMessage?.message
                || messageContent?.viewOnceMessage?.message
                || messageContent?.viewOnceMessageV2?.message
                || messageContent;

            const messageText = unwrappedContent?.conversation ||
                unwrappedContent?.extendedTextMessage?.text || '';

            // Tipos de mídia suportados (incluindo variantes do Evolution API v2)
            const MEDIA_TYPES = [
                'imageMessage',
                'documentMessage',
                'documentWithCaptionMessage', // PDF com legenda no Evolution v2
                'videoMessage',
                'audioMessage'
            ];

            // Se veio como messageContextInfo, procura o tipo real dentro dele
            let messageType = Object.keys(unwrappedContent || {})[0] || 'unknown';
            if (messageType === 'messageContextInfo') {
                const tipoReal = Object.keys(messageContent || {}).find(k =>
                    k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
                );
                messageType = tipoReal || 'unknown';
            }

            // Para documentWithCaptionMessage, o conteúdo real está um nível abaixo
            const effectiveContent = messageType === 'documentWithCaptionMessage'
                ? messageContent?.documentWithCaptionMessage?.message
                : messageContent;

            const isMediaMessage = MEDIA_TYPES.includes(messageType);

            if (!messageText && !isMediaMessage) return res.status(200).json({ success: true });

            logger.info('Mensagem recebida', {
                from: phoneNumber,
                name: pushName,
                type: messageType,
                isMedia: isMediaMessage,
                hasText: !!messageText,
                messageKeys: Object.keys(messageContent || {}).join(','),
                message: messageText.substring(0, 100)
            });

            // ── CORREÇÃO 2: Filtro pessoal/profissional COM histórico ──────────
            // Antes passava [] vazio — mensagens curtas dentro de conversa jurídica
            // ativa (ex: "n tenho numero" do Pedro) eram classificadas como pessoais.
            // Agora busca as últimas 3 mensagens para dar contexto à IA do detector.
            let historicoParaFiltro = [];
            try {
                const convAtiva = await db.query(
                    `SELECT id FROM conversations WHERE telefone = $1 AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
                    [phoneNumber]
                );
                if (convAtiva.rows.length > 0) {
                    const ultMsgs = await db.query(
                        `SELECT sender, conteudo FROM messages WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT 3`,
                        [convAtiva.rows[0].id]
                    );
                    historicoParaFiltro = ultMsgs.rows.reverse().map(m => ({
                        sender: m.sender,
                        conteudo: m.conteudo
                    }));
                }
            } catch (e) {
                // Não bloqueia o fluxo se falhar — continua com histórico vazio
            }

            // ── Filtro combinado: pessoal + relevância jurídica ───────────────
            // Classifica em 3 categorias:
            //   "juridico"  → responder (assunto de advocacia/direito)
            //   "saudacao"  → responder (primeiro contato, contexto vazio)
            //   "ignorar"   → silêncio total (pessoal, spam, outros negócios)
            //
            // "incerto" com histórico jurídico ativo → tratar como jurídico
            // "incerto" sem histórico → ignorar (evita responder boleto, provedor, etc.)

            // Advogado nunca é filtrado
            if (!isAdvogado(phoneNumber)) {
                let deveIgnorar = false;

                try {
                    const textoFiltro = messageText || '[mídia recebida]';
                    const historicoTexto = historicoParaFiltro.length > 0
                        ? historicoParaFiltro
                            .map(m => `[${m.sender === 'customer' ? 'CLIENTE' : 'BOT'}]: ${m.conteudo}`)
                            .join('\n')
                        : 'Sem histórico — primeira mensagem.';

                    const respFiltro = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                        },
                        body: JSON.stringify({
                            model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                            messages: [
                                {
                                    role: 'system',
                                    content: `Você é o filtro de entrada de um escritório de advocacia no WhatsApp.
Analise a mensagem recebida e o histórico recente. Classifique em UMA das categorias:

"juridico" — assunto relacionado a direito, advocacia, processos judiciais, contratos, documentos jurídicos, consultas legais, divórcio, herança, trabalhista, previdenciário, criminal, agendamento com advogado, perguntas que um advogado pode responder. Também classifique como "juridico" mensagens curtas de continuação (ok, entendido, sim, não, obrigado) quando o HISTÓRICO já está tratando de assunto jurídico.

"saudacao" — primeira mensagem de uma pessoa real sem histórico jurídico (ex: "olá", "bom dia", "oi preciso de ajuda") — deve ser respondida para entender o que a pessoa precisa.

"ignorar" — tudo que NÃO é jurídico e não é de uma pessoa procurando um advogado:
  • Mensagens automáticas de sistemas (boletos, cobranças, confirmações, provedores, bancos)
  • Spam, propaganda, marketing
  • Assuntos completamente fora de advocacia (delivery, saúde, tecnologia sem relação jurídica)
  • Mensagens pessoais claramente não relacionadas a assunto jurídico
  • Saudações genéricas quando o histórico mostra que é número de sistema ou spam
  • Mensagens curtas ambíguas (ok, certo, entendido) quando NÃO há histórico jurídico

Regra de ouro: na dúvida entre "juridico" e "ignorar", escolha "ignorar".
Na dúvida entre "saudacao" e "ignorar" sem histórico, escolha "ignorar".
Só responda "saudacao" quando for claramente uma pessoa real iniciando contato.

Responda APENAS uma palavra: juridico, saudacao ou ignorar`
                                },
                                {
                                    role: 'user',
                                    content: `Histórico recente:\n${historicoTexto}\n\nMensagem recebida: "${textoFiltro}"\n\nClassifique:`
                                }
                            ],
                            max_tokens: 10,
                            temperature: 0.1
                        })
                    });

                    if (respFiltro.ok) {
                        const dadosFiltro = await respFiltro.json();
                        const classificacao = dadosFiltro.choices[0].message.content
                            .trim().toLowerCase().replace(/[^a-záéíóúãõç]/g, '');

                        logger.info('Filtro jurídico', {
                            phoneNumber,
                            classificacao,
                            message: textoFiltro.substring(0, 60)
                        });

                        if (classificacao === 'ignorar') {
                            deveIgnorar = true;
                        }
                        // "juridico" e "saudacao" → continua normalmente
                    }
                } catch (filtroErr) {
                    // Se o filtro falhar, continua (melhor responder do que ignorar cliente real)
                    logger.warn('Filtro jurídico falhou — continuando', { error: filtroErr.message });
                }

                if (deveIgnorar) {
                    logger.info('Mensagem ignorada pelo filtro jurídico', {
                        phoneNumber,
                        message: (messageText || '').substring(0, 80)
                    });
                    return res.status(200).json({ success: true, action: 'filtered_non_juridico' });
                }
            }

            // ── Comando direto #email — sem buffer ───────────────────────────
            if (messageText.trim().toLowerCase().startsWith('#email')) {
                if (!isAdvogado(phoneNumber)) {
                    const msgSemPermissao = await groqAI.generateContextualMessage('sem_permissao_email', {});
                    await evolutionAPI.sendTextMessage(phoneNumber, msgSemPermissao);
                    return res.status(200).json({ success: true });
                }
                await emailService.handleWhatsAppCommand(messageText, phoneNumber);
                return res.status(200).json({ success: true });
            }

            // ── Comando #chat — canal privado advogado ↔ IA ─────────────────
            // Só o advogado pode usar. Resposta imediata sem buffer.
            if (messageText.trim().toLowerCase().startsWith('#chat')) {
                if (!isAdvogado(phoneNumber)) {
                    await evolutionAPI.sendTextMessage(phoneNumber,
                        'Este comando é exclusivo do advogado.');
                    return res.status(200).json({ success: true });
                }
                try {
                    await evolutionAPI.sendTyping(phoneNumber, true).catch(() => {});
                    const respostaChat = await advogadoChat.processarChatAdvogado(messageText.trim());
                    await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});
                    await evolutionAPI.sendTextMessage(phoneNumber, respostaChat);
                    logger.info('Chat advogado processado', {
                        comando: messageText.substring(0, 60)
                    });
                } catch (chatErr) {
                    await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});
                    logger.error('Erro no chat do advogado', { error: chatErr.message });
                    await evolutionAPI.sendTextMessage(phoneNumber,
                        '❌ Erro ao processar comando. Tente novamente.');
                }
                return res.status(200).json({ success: true });
            }

            // ── Verifica conversa encerrada — reabre ou cria nova ────────────
            const convCheck = await db.query(
                `SELECT id, status, ultimo_estado FROM conversations WHERE telefone = $1 ORDER BY updated_at DESC LIMIT 1`,
                [phoneNumber]
            );
            if (convCheck.rows.length > 0 && convCheck.rows[0].status === 'closed') {
                const oldConvId = convCheck.rows[0].id;
                const ultimoEstado = convCheck.rows[0].ultimo_estado;

                logger.info('Conversa encerrada — analisando reativacao', { phoneNumber, oldConvId, ultimoEstado });

                const sempreNovaConversa = ['opt_out_cliente', 'recuperacao_ignorada'];
                let assuntoResolvido = sempreNovaConversa.includes(ultimoEstado);

                if (!assuntoResolvido) {
                    try {
                        const historicoAnterior = await db.query(
                            `SELECT sender, conteudo FROM messages WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT 10`,
                            [oldConvId]
                        );
                        const contexto = historicoAnterior.rows.reverse()
                            .map(m => `[${m.sender === 'customer' ? 'CLIENTE' : 'BOT'}]: ${m.conteudo}`)
                            .join('\n');

                        const analise = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
                            body: JSON.stringify({
                                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                                messages: [
                                    {
                                        role: 'system',
                                        content: `Voce analisa conversas encerradas de um escritorio de advocacia. O cliente voltou a enviar mensagem. Analise o historico e decida se o assunto anterior foi resolvido ou ficou pendente. Responda APENAS JSON: {"resolvido": true/false, "motivo": "resumo curto"}`
                                    },
                                    {
                                        role: 'user',
                                        content: `Historico:\n${contexto}\n\nNova mensagem: "${messageText}"\n\nAssunto resolvido?`
                                    }
                                ],
                                max_tokens: 80,
                                temperature: 0.1
                            })
                        });

                        if (analise.ok) {
                            const analiseData = await analise.json();
                            const texto = analiseData.choices[0].message.content.replace(/```json|```/g, '').trim();
                            const resultado = JSON.parse(texto);
                            assuntoResolvido = resultado.resolvido;
                            logger.info('Analise de reativacao concluida', { phoneNumber, assuntoResolvido, motivo: resultado.motivo });
                        }
                    } catch (e) {
                        logger.warn('Erro na analise de reativacao, assumindo nova conversa', { error: e.message });
                        assuntoResolvido = true;
                    }
                }

                const clienteReat = await db.query('SELECT id FROM clientes WHERE telefone = $1', [phoneNumber]);
                const clienteIdReat = clienteReat.rows[0]?.id;

                if (assuntoResolvido) {
                    await db.query(
                        `INSERT INTO conversations (cliente_id, telefone, status, ultimo_estado) VALUES ($1, $2, 'active', 'nova_conversa') RETURNING id`,
                        [clienteIdReat, phoneNumber]
                    );
                    logger.info('Nova conversa criada (assunto anterior resolvido)', { phoneNumber });
                } else {
                    await db.query(
                        `UPDATE conversations SET status = 'active', ultimo_estado = 'reaberta', updated_at = NOW() WHERE id = $1`,
                        [oldConvId]
                    );
                    logger.info('Conversa reaberta (assunto pendente)', { oldConvId, phoneNumber });
                }
            }

            // ── Responde Evolution API imediatamente ─────────────────────────
            res.status(200).json({ success: true });

            // Marcar como lida (ticks azuis)
            evolutionAPI.markAsRead(phoneNumber, key.id).catch(e =>
                logger.warn('markAsRead falhou', { error: e.message })
            );

            // ── processarBuffer — função única de resposta da IA ─────────────
            // Declarada ANTES do bloco de mídia para evitar erro de hoisting.
            // Tanto texto quanto mídia usam esta mesma função.
            // A IA só é chamada UMA vez, após 2 minutos de silêncio do cliente.
            const processarBuffer = async (combinedText) => {
                try {
                    // nomeCliente com fallback imediato — sobrescrito após busca no banco
                    let nomeCliente = pushName || phoneNumber;

                    // Detecção automática de e-mail em linguagem natural (só advogado)
                    if (isAdvogado(phoneNumber) && detectEmailRequest(combinedText)) {
                        const command = parseEmailIntent(combinedText);
                        logger.info('E-mail detectado automaticamente', { command });
                        await emailService.handleWhatsAppCommand(command, phoneNumber);
                        return;
                    }

                    // ── Buscar/criar cliente ──────────────────────────────────
                    let clienteResult = await db.query('SELECT id FROM clientes WHERE telefone = $1', [phoneNumber]);
                    let clienteId;
                    if (clienteResult.rows.length === 0) {
                        const r = await db.query(
                            'INSERT INTO clientes (telefone, nome) VALUES ($1, $2) RETURNING id',
                            [phoneNumber, pushName || 'Cliente']
                        );
                        clienteId = r.rows[0].id;
                        logger.info('Novo cliente criado', { clienteId, telefone: phoneNumber });
                    } else {
                        clienteId = clienteResult.rows[0].id;
                    }

                    // ── Buscar/criar conversa ─────────────────────────────────
                    let conversationResult = await db.query(
                        `SELECT id, status, transferido_para_humano FROM conversations WHERE telefone = $1 AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
                        [phoneNumber]
                    );
                    let conversationId;
                    if (conversationResult.rows.length === 0) {
                        const r = await db.query(
                            'INSERT INTO conversations (cliente_id, telefone, status) VALUES ($1, $2, $3) RETURNING id',
                            [clienteId, phoneNumber, 'active']
                        );
                        conversationId = r.rows[0].id;
                        logger.info('Nova conversa criada', { conversationId, telefone: phoneNumber });
                    } else {
                        conversationId = conversationResult.rows[0].id;
                    }

                    // Atualizar nome com dado real do banco (tem prioridade sobre pushName)
                    const clienteNomeResult = await db.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
                    nomeCliente = clienteNomeResult.rows[0]?.nome || pushName || phoneNumber;

                    // Salvar mensagem do cliente
                    await db.query(
                        'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp) VALUES ($1, $2, $3, $4, NOW())',
                        [conversationId, 'customer', combinedText, 'text']
                    );

                    // ── 0. MONITORAMENTO PÓS-TRANSFERÊNCIA ───────────────────
                    const convAtualResult = await db.query(
                        `SELECT transferido_para_humano FROM conversations WHERE id = $1`,
                        [conversationId]
                    );
                    const estaTransferido = convAtualResult.rows[0]?.transferido_para_humano === true;

                    if (estaTransferido) {
                        // Monitoramento silencioso — salva a mensagem do cliente sem interagir
                        await monitoramento.processarMensagemMonitorada(
                            conversationId, phoneNumber, combinedText, 'cliente'
                        );

                        const deveRetomar = await deveRetomarAposTransferencia(combinedText, historicoParaFiltro);

                        if (deveRetomar) {
                            logger.info('Bot retomando conversa transferida (assunto profissional)', {
                                conversationId, phoneNumber
                            });
                            // Gerar resumo do atendimento humano antes de retomar
                            monitoramento.encerrarAtendimentoHumano(conversationId).catch(() => {});
                            await db.query(
                                'UPDATE conversations SET transferido_para_humano = FALSE, updated_at = NOW() WHERE id = $1',
                                [conversationId]
                            );
                        } else {
                            logger.info('Conversa transferida — monitorando silenciosamente', {
                                conversationId, phoneNumber,
                                message: combinedText.substring(0, 60)
                            });
                            return;
                        }
                    }

                    // ── 1. CONSULTA PROCESSUAL ────────────────────────────────
                    const resultadoProcesso = await processoHandler.processar(
                        combinedText, conversationId, clienteId, phoneNumber
                    );

                    if (resultadoProcesso) {
                        logger.info('Consulta processual processada', {
                            conversationId,
                            sucesso: resultadoProcesso.sucesso,
                            situacao: resultadoProcesso.situacao,
                            novoCliente: resultadoProcesso.novoCliente || false
                        });

                        let msgProcesso;

                        if (resultadoProcesso.situacao === 'processo_encontrado') {
                            const dadosFormatados = processoHandler.formatarResposta(
                                resultadoProcesso.dados,
                                resultadoProcesso.numeroProcesso
                            );
                            msgProcesso = await groqAI.generateContextualMessage('processo_encontrado_resumo', {
                                clienteNome: nomeCliente, dadosFormatados
                            });
                        } else if (resultadoProcesso.situacao === 'processos_no_banco') {
                            msgProcesso = await groqAI.generateContextualMessage('processos_no_banco', {
                                clienteNome: nomeCliente,
                                processos: resultadoProcesso.dados.processos
                            });
                        } else if (resultadoProcesso.situacao === 'numeros_encontrados_fontes') {
                            msgProcesso = await groqAI.generateContextualMessage('numeros_encontrados_fontes', {
                                clienteNome: nomeCliente,
                                numerosEncontrados: resultadoProcesso.dados.numerosEncontrados
                            });
                        } else if (resultadoProcesso.situacao === 'processos_encontrados_datajud_nome') {
                            msgProcesso = await groqAI.generateContextualMessage('processos_encontrados_datajud_nome', {
                                clienteNome: nomeCliente,
                                processosPorNome: resultadoProcesso.dados.processosPorNome
                            });
                        } else {
                            msgProcesso = await groqAI.generateContextualMessage(
                                resultadoProcesso.situacao,
                                {
                                    clienteNome: nomeCliente,
                                    numeroProcesso: resultadoProcesso.dados?.numeroProcesso
                                }
                            );
                        }

                        await evolutionAPI.sendTextMessage(phoneNumber, msgProcesso);
                        await db.query(
                            'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata) VALUES ($1, $2, $3, $4, NOW(), $5)',
                            [conversationId, 'bot', msgProcesso, 'text',
                                JSON.stringify({
                                    tipo: resultadoProcesso.novoCliente
                                        ? 'consulta_processual_novo_cliente'
                                        : 'consulta_processual',
                                    processoId: resultadoProcesso.processoId,
                                    situacao: resultadoProcesso.situacao
                                })]
                        );
                        await db.query(
                            'UPDATE conversations SET ultimo_estado = $1, updated_at = NOW() WHERE id = $2',
                            [
                                resultadoProcesso.novoCliente
                                    ? 'novo_cliente_consulta_processo'
                                    : 'consulta_processo',
                                conversationId
                            ]
                        );
                        if (!resultadoProcesso.novoCliente) return;
                    }

                    // ── Buscar histórico completo ─────────────────────────────
                    const historicoResult = await db.query(
                        `SELECT sender, conteudo FROM messages WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT 15`,
                        [conversationId]
                    );
                    const historico = historicoResult.rows.reverse();

                    // ── 2. OPT-OUT via IA ─────────────────────────────────────
                    const isOptOut = await detectOptOutComIA(combinedText, historico);
                    if (isOptOut) {
                        logger.info('Opt-out detectado pela IA', { phoneNumber, conversationId });
                        const despedida = await groqAI.generateContextualMessage('opt_out', {
                            clienteNome: nomeCliente
                        });
                        await evolutionAPI.sendTextMessage(phoneNumber, despedida);
                        await db.query(
                            'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp) VALUES ($1, $2, $3, $4, NOW())',
                            [conversationId, 'bot', despedida, 'text']
                        );
                        await db.query(
                            `UPDATE conversations SET status = 'closed', ultimo_estado = 'opt_out_cliente', updated_at = NOW() WHERE id = $1`,
                            [conversationId]
                        );
                        return;
                    }

                    // ── 3. TRANSFERÊNCIA para advogado via IA ─────────────────
                    const decisaoTransferencia = await detectTransferenciaComIA(combinedText, historico);

                    if (decisaoTransferencia === 'sim') {
                        await evolutionAPI.sendTyping(phoneNumber, true).catch(() => {});
                        const transferResult = await groqAI.generateResponse(
                            conversationId,
                            '__TRANSFERENCIA__',
                            {
                                pushName,
                                instrucaoEspecial: `O cliente pediu para falar com o advogado. Informe de forma cordial que o Dr. Wanderson Mailson irá atendê-lo em breve e que pode continuar enviando informações enquanto aguarda.`
                            }
                        );
                        await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});

                        const msgTransfer = transferResult.success
                            ? transferResult.response
                            : 'O Dr. Wanderson Mailson irá atendê-lo em breve. Fique à vontade para continuar enviando informações.';

                        await db.query(
                            'UPDATE conversations SET transferido_para_humano = TRUE, updated_at = NOW() WHERE id = $1',
                            [conversationId]
                        );
                        await evolutionAPI.sendTextMessage(phoneNumber, msgTransfer);
                        await db.query(
                            'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp) VALUES ($1, $2, $3, $4, NOW())',
                            [conversationId, 'bot', msgTransfer, 'text']
                        );
                        logger.info('Conversa transferida para humano (IA confirmou)', { conversationId });
                        return;
                    }

                    if (decisaoTransferencia === 'ambiguo') {
                        await evolutionAPI.sendTyping(phoneNumber, true).catch(() => {});
                        const perguntaResult = await groqAI.generateResponse(
                            conversationId,
                            '__TRANSFERENCIA_AMBIGUA__',
                            {
                                pushName,
                                instrucaoEspecial: `O cliente enviou uma mensagem que pode indicar que quer falar com o advogado, mas não está claro.
Formule uma pergunta curta perguntando se ele deseja ser atendido diretamente pelo Dr. Wanderson Mailson ou se prefere continuar com o assistente virtual.
Tom: cordial, objetivo.`
                            }
                        );
                        await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});

                        const msgAmbigua = perguntaResult.success
                            ? perguntaResult.response
                            : 'Gostaria de ser atendido diretamente pelo Dr. Wanderson Mailson, ou posso continuar ajudando com sua dúvida?';

                        await evolutionAPI.sendTextMessage(phoneNumber, msgAmbigua);
                        await db.query(
                            'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp) VALUES ($1, $2, $3, $4, NOW())',
                            [conversationId, 'bot', msgAmbigua, 'text']
                        );
                        logger.info('Transferência ambígua — perguntando ao cliente', { conversationId });
                        return;
                    }

                    // ── 4. COLETA DE NOVO CASO ────────────────────────────────
                    try {
                        const casoEmColeta = await db.query(
                            `SELECT id FROM casos_em_coleta WHERE conversation_id = $1 AND status = 'em_coleta'`,
                            [conversationId]
                        );
                        if (casoEmColeta.rows.length > 0) {
                            logger.info('Continuando coleta de caso', { conversationId });
                            const caseResult = await newcasecollector.processConversation(conversationId, historico);
                            if (caseResult.action === 'collect') {
                                await evolutionAPI.sendTyping(phoneNumber, true).catch(() => {});
                                await new Promise(r => setTimeout(r, 800));
                                await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});
                                await evolutionAPI.sendTextMessage(phoneNumber, caseResult.message);
                                await db.query(
                                    'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp) VALUES ($1, $2, $3, $4, NOW())',
                                    [conversationId, 'bot', caseResult.message, 'text']
                                );
                                return;
                            }
                            if (caseResult.action === 'complete') {
                                await evolutionAPI.sendTyping(phoneNumber, true).catch(() => {});
                                await new Promise(r => setTimeout(r, 1000));
                                await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});
                                await evolutionAPI.sendTextMessage(phoneNumber, caseResult.message);
                                await db.query(
                                    'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata) VALUES ($1, $2, $3, $4, NOW(), $5)',
                                    [conversationId, 'bot', caseResult.message, 'text',
                                        JSON.stringify({ tipo: 'caso_finalizado', processoId: caseResult.data?.processoId })]
                                );
                                await db.query(
                                    `UPDATE conversations SET ultimo_estado = 'caso_coletado', updated_at = NOW() WHERE id = $1`,
                                    [conversationId]
                                );
                                return;
                            }
                        }
                    } catch (casoErr) {
                        logger.debug('Tabela casos_em_coleta nao encontrada', { error: casoErr.message });
                    }

                    // ── 5. IA CONVERSACIONAL ──────────────────────────────────
                    await evolutionAPI.sendTyping(phoneNumber, true).catch(() => {});
                    const aiResult = await groqAI.generateResponse(conversationId, combinedText, { pushName });
                    await evolutionAPI.sendTyping(phoneNumber, false).catch(() => {});

                    if (aiResult.success) {
                        await evolutionAPI.sendTextMessage(phoneNumber, aiResult.response);
                        await db.query(
                            'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata) VALUES ($1, $2, $3, $4, NOW(), $5)',
                            [conversationId, 'bot', aiResult.response, 'text', JSON.stringify(aiResult.metadata)]
                        );
                        const sentiment = groqAI.analyzeSentiment(combinedText);
                        const intent = groqAI.detectIntent(combinedText);
                        await db.query(
                            'UPDATE conversations SET ultimo_estado = $1, updated_at = NOW() WHERE id = $2',
                            [intent, conversationId]
                        );
                        logger.info('Resposta enviada', {
                            conversationId, responseLength: aiResult.response.length, sentiment, intent
                        });
                    } else {
                        logger.error('Falha ao gerar resposta IA', { conversationId });
                        const msgErro = await groqAI.generateContextualMessage('erro_ia', {
                            clienteNome: nomeCliente
                        });
                        await evolutionAPI.sendTextMessage(phoneNumber, msgErro);
                    }

                } catch (err) {
                    logger.error('Erro ao processar buffer', { error: err.message, stack: err.stack });
                }
            }; // fim processarBuffer

            // ── Processamento de mídia — download imediato, resposta via buffer ─
            // O arquivo é baixado, analisado e salvo agora.
            // A resposta ao cliente entra no buffer de 2 minutos junto com
            // qualquer texto que o cliente mandar na sequência.
            if (isMediaMessage) {
                (async () => {
                    try {
                        let clienteResult = await db.query('SELECT id FROM clientes WHERE telefone = $1', [phoneNumber]);
                        let clienteId;
                        if (clienteResult.rows.length === 0) {
                            const r = await db.query(
                                'INSERT INTO clientes (telefone, nome) VALUES ($1, $2) RETURNING id',
                                [phoneNumber, pushName || 'Cliente']
                            );
                            clienteId = r.rows[0].id;
                        } else {
                            clienteId = clienteResult.rows[0].id;
                        }

                        const clienteInfoNome = await db.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
                        const nomeCliente = clienteInfoNome.rows[0]?.nome || pushName || phoneNumber;

                        let conversationResult = await db.query(
                            `SELECT id FROM conversations WHERE telefone = $1 AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
                            [phoneNumber]
                        );
                        let conversationId;
                        if (conversationResult.rows.length === 0) {
                            const r = await db.query(
                                'INSERT INTO conversations (cliente_id, telefone, status) VALUES ($1, $2, $3) RETURNING id',
                                [clienteId, phoneNumber, 'active']
                            );
                            conversationId = r.rows[0].id;
                        } else {
                            conversationId = conversationResult.rows[0].id;
                        }

                        const mediaMsg = effectiveContent?.[messageType]
                            || messageContent?.[messageType]
                            || messageContent?.documentWithCaptionMessage?.message?.documentMessage;
                        const mediaUrl = mediaMsg?.url || mediaMsg?.directPath || null;
                        const filename = mediaMsg?.fileName ||
                            mediaMsg?.title ||
                            `arquivo_${Date.now()}.${
                                messageType === 'imageMessage' ? 'jpg' :
                                messageType === 'audioMessage' ? 'ogg' :
                                messageType === 'videoMessage' ? 'mp4' : 'pdf'
                            }`;
                        const mimeType = mediaMsg?.mimetype || 'application/octet-stream';
                        const caption = mediaMsg?.caption || '';

                        if (!mediaUrl) {
                            logger.warn('URL de midia nao encontrada', { messageType, phoneNumber });
                            // Injeta aviso no buffer para a IA mencionar na resposta
                            bufferMessage(phoneNumber, '[MÍDIA: falha ao baixar o arquivo]', processarBuffer);
                            return;
                        }

                        logger.info('Processando mídia recebida', { filename, mimeType, conversationId });

                        // ── Processar arquivo imediatamente (não espera o buffer) ──
                        const docResult = await documentprocessor.handleWhatsAppDocument({
                            mediaUrl, filename, mimeType, conversationId, clienteId,
                            processoId: null, caption, messageId: key.id || null
                        });

                        // ── Salvar mensagem do cliente no banco ───────────────────
                        const descricaoMidia = caption
                            ? `[ARQUIVO: ${filename}] ${caption}`
                            : `[ARQUIVO: ${filename}]`;
                        await db.query(
                            'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata) VALUES ($1, $2, $3, $4, NOW(), $5)',
                            [conversationId, 'customer', descricaoMidia, messageType,
                                JSON.stringify({ filename, categoria: docResult.categoria, documentoId: docResult.documentoId })]
                        );

                        // ── Se conseguiu ler o conteúdo, salva como contexto ──────
                        if (docResult.textoParaIA && docResult.textoParaIA.length > 20) {
                            await db.query(
                                'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata) VALUES ($1, $2, $3, $4, NOW(), $5)',
                                [conversationId, 'system',
                                    `[Conteúdo da imagem/documento]: ${docResult.textoParaIA}`,
                                    'image_context',
                                    JSON.stringify({ documentoId: docResult.documentoId, tipo: 'contexto_midia' })]
                            );
                        }

                        // ── Notificação imediata ao advogado ──────────────────────
                        if (docResult.success && process.env.EMAIL_NOTIFY_PHONE) {
                            try {
                                const advPhone = process.env.EMAIL_NOTIFY_PHONE.replace(/\D/g, '');
                                const categoriaEmoji = {
                                    peticao: '📋', sentenca: '⚖️', contrato: '📑',
                                    procuracao: '📜', certidao: '📜', rg: '🪪',
                                    cpf: '📋', ctps: '📄', extrato: '💰',
                                    laudo: '⚕️', recibo: '🧾', comprovante_residencia: '🏠',
                                    outros: '📎'
                                };
                                const emoji = categoriaEmoji[docResult.categoria] || '📎';
                                let notifMsg = `${emoji} *Documento recebido de cliente*\n\n`;
                                notifMsg += `👤 *Cliente:* ${nomeCliente} (${phoneNumber})\n`;
                                notifMsg += `📁 *Arquivo:* ${filename}\n`;
                                notifMsg += `🏷️ *Categoria:* ${docResult.categoria || 'outros'}\n`;
                                if (caption) notifMsg += `💬 *Legenda:* ${caption}\n`;
                                if (docResult.resumo &&
                                    docResult.resumo !== 'Texto não extraído — documento salvo para análise manual') {
                                    notifMsg += `\n📝 *Resumo:*\n${docResult.resumo}`;
                                } else {
                                    notifMsg += `\n⚠️ Texto não extraído — verifique manualmente.`;
                                }
                                if (docResult.analysis?.numero_processo) {
                                    notifMsg += `\n\n🔢 *Nº Processo:* ${docResult.analysis.numero_processo}`;
                                }
                                await evolutionAPI.sendTextMessage(advPhone, notifMsg);
                                logger.info('Notificação de documento enviada ao advogado', {
                                    advPhone, cliente: nomeCliente, categoria: docResult.categoria
                                });
                            } catch (notifErr) {
                                logger.warn('Falha ao notificar advogado sobre documento', { error: notifErr.message });
                            }
                        }

                        // ── Injetar no buffer — IA responde após 2 minutos ───────────
                        // Acumula junto com textos do cliente. Timer reinicia a cada nova
                        // mensagem — a IA só fala UMA vez, com contexto completo.
                        let tokenBuffer = '';
                        if (docResult.textoParaIA && docResult.textoParaIA.length > 20) {
                            tokenBuffer = caption
                                ? `[ARQUIVO: ${filename} | Legenda: "${caption}"]\nConteúdo analisado: ${docResult.textoParaIA}`
                                : `[ARQUIVO: ${filename}]\nConteúdo analisado: ${docResult.textoParaIA}`;
                        } else if (caption) {
                            tokenBuffer = `[ARQUIVO RECEBIDO: ${filename}] ${caption}`;
                        } else {
                            tokenBuffer = `[ARQUIVO RECEBIDO: ${filename} — texto não extraído, salvo para análise manual]`;
                        }

                        bufferMessage(phoneNumber, tokenBuffer, processarBuffer);

                        logger.info('Mídia processada e injetada no buffer', {
                            filename, categoria: docResult.categoria, viaVision: docResult.viaVision
                        });

                    } catch (err) {
                        logger.error('Erro ao processar midia', { error: err.message, stack: err.stack });
                    }
                })();

                // Mídia processada — se não tinha texto junto, o token já foi
                // injetado no buffer via bufferMessage(tokenBuffer, processarBuffer)
                // acima. Não precisa processar mais nada aqui.
                if (!messageText) return;
            }

            // Registrar mensagem de texto no buffer
            if (messageText) {
                bufferMessage(phoneNumber, messageText, processarBuffer);
            }

            return;
        }

        res.status(200).json({ success: true });

    } catch (error) {
        logger.error('Erro no webhook', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: 'Erro ao processar webhook' });
    }
});

module.exports = router;