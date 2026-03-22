const logger = require('../utils/logger');
const db = require('./database');

/**
 * Serviço para detectar conversas pessoais e evitar interação indevida
 * 
 * VERSÃO FINAL CORRIGIDA - Com:
 * 1. Bloqueio de serviços não-jurídicos (IPTV, streaming, senhas)
 * 2. Classificação tripla com IA (pessoal/profissional/INCERTO)
 * 3. Pergunta de esclarecimento quando ambíguo
 */

class ConversationTypeDetector {
    constructor() {
        // Palavras-chave que indicam conversa pessoal
        this.personalKeywords = [
            'amor', 'querido', 'querida', 'meu bem', 'minha vida',
            'te amo', 'saudades', 'beijo', 'beijinho',
            'família', 'mãe', 'pai', 'filho', 'filha',
            'aniversário', 'festa', 'churras', 'encontro',
            'jogo', 'futebol', 'novela', 'filme',
            'boa noite amor', 'bom dia amor', 'como você está',
            'tudo bem com você', 'como foi seu dia',
            'jantar', 'almoço', 'café', 'bebe', 'bb',
            // 🆕 Serviços não-jurídicos
            'senha', 'renovação', 'vencimento', 'usuário',
            'playlist', 'player', 'streaming', 'iptv',
            'core player', 'aplicativo', 'teste'
        ];

        // Indicadores de conversa profissional/jurídica
        this.professionalKeywords = [
            'processo', 'advogado', 'advocacia', 'jurídico', 'consulta',
            'demissão', 'trabalhista', 'divórcio', 'pensão',
            'contrato', 'ação', 'tribunal', 'juiz', 'sentença',
            'inss', 'aposentadoria', 'fgts', 'rescisão',
            'direito', 'lei', 'legal', 'ilegal', 'crime',
            'dúvida jurídica', 'preciso de um advogado',
            'quero contratar', 'agendar consulta', 'agenda', 'dr', 'doutor'
        ];

        // Padrões de grupos pessoais (regex)
        this.personalGroupPatterns = [
            /família/i,
            /amigos/i,
            /turma/i,
            /galera/i,
            /pessoal/i,
            /churras/i,
            /aniversário/i,
            /casamento/i
        ];

        // 🆕 NOVO: Padrões de serviços não-jurídicos (bloqueio automático)
        this.nonLegalServicePatterns = [
            /core player/i,
            /iptv/i,
            /streaming/i,
            /playlist/i,
            /renovação.*serviço/i,
            /confirmação.*renovação/i,
            /senha.*\d{6,}/i,        // Senha com 6+ dígitos
            /usuário.*\d{6,}/i,      // Usuário com 6+ dígitos
            /próximo vencimento/i,
            /teste.*gerado/i
        ];
    }

    /**
     * 🆕 NOVO: Detecta serviços não-jurídicos (IPTV, streaming, etc)
     */
    isNonLegalService(message) {
        const lowerMessage = message.toLowerCase();
        
        for (const pattern of this.nonLegalServicePatterns) {
            if (pattern.test(lowerMessage)) {
                logger.info('Serviço não-jurídico detectado', { 
                    message: message.substring(0, 50),
                    pattern: pattern.toString() 
                });
                return true;
            }
        }
        
        return false;
    }

    /**
     * Verifica se a mensagem é de um grupo pessoal
     */
    isPersonalGroup(groupName, groupDescription = '') {
        if (!groupName) return false;

        const fullText = `${groupName} ${groupDescription}`.toLowerCase();

        for (const pattern of this.personalGroupPatterns) {
            if (pattern.test(fullText)) {
                logger.info('Grupo pessoal detectado', { 
                    groupName, 
                    pattern: pattern.toString() 
                });
                return true;
            }
        }

        return false;
    }

    /**
     * Analisa o conteúdo da mensagem para determinar se é pessoal ou profissional
     */
    analyzeMessageContent(message, conversationHistory = []) {
        const lowerMessage = message.toLowerCase();

        const personalCount = this.personalKeywords.filter(keyword => 
            lowerMessage.includes(keyword)
        ).length;

        const professionalCount = this.professionalKeywords.filter(keyword => 
            lowerMessage.includes(keyword)
        ).length;

        let historyPersonalCount = 0;
        let historyProfessionalCount = 0;

        if (conversationHistory.length > 0) {
            const recentHistory = conversationHistory.slice(-5);
            
            recentHistory.forEach(msg => {
                const lowerContent = (msg.conteudo || msg.content || '').toLowerCase();
                historyPersonalCount += this.personalKeywords.filter(k => lowerContent.includes(k)).length;
                historyProfessionalCount += this.professionalKeywords.filter(k => lowerContent.includes(k)).length;
            });
        }

        const totalPersonal = personalCount + (historyPersonalCount * 0.3);
        const totalProfessional = professionalCount + (historyProfessionalCount * 0.3);

        return {
            isPersonal: totalPersonal > totalProfessional,
            isProfessional: totalProfessional > totalPersonal,
            confidence: Math.abs(totalPersonal - totalProfessional) / Math.max(totalPersonal, totalProfessional, 1),
            scores: {
                personal: totalPersonal,
                professional: totalProfessional
            }
        };
    }

    /**
     * 🆕 CORRIGIDO: Análise com IA - CLASSIFICAÇÃO TRIPLA
     * Retorna: pessoal, profissional ou INCERTO
     */
    async analyzeWithAI(message, conversationHistory) {
        try {
            const historyText = conversationHistory
                .slice(-5)
                .map(m => `${m.sender === 'customer' ? 'Cliente' : 'Assistente'}: ${m.conteudo}`)
                .join('\n');

            const prompt = `Você classifica mensagens para um escritório de advocacia (LOPES ADVOCACIA).

CONTEXTO DAS ÚLTIMAS MENSAGENS:
${historyText}

MENSAGEM ATUAL:
"${message}"

CLASSIFICAÇÕES:
1. **PROFISSIONAL** - Claramente sobre serviços jurídicos (processos, leis, consultas, contratos, FGTS, INSS, trabalhista, divórcio, pensão, tribunal, advogado)
2. **PESSOAL** - Claramente NÃO-jurídico (família, amigos, senhas, IPTV, streaming, renovações, conversas casuais)
3. **INCERTO** - Mensagem ambígua, muito curta ou sem contexto suficiente para decidir

EXEMPLOS INCERTOS:
- "oi" (pode ser início de conversa profissional OU pessoal)
- "olá" (ambíguo)
- "bom dia" (ambíguo)
- "tudo bem?" (ambíguo)
- Mensagens muito curtas sem contexto

REGRA: Se a mensagem for ambígua ou muito curta SEM contexto jurídico claro, classifique como INCERTO.

Responda APENAS com JSON:
{
  "classification": "profissional" | "pessoal" | "incerto",
  "confidence": 0.0-1.0,
  "reason": "explicação breve"
}`;

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
                            content: 'Você classifica mensagens com TRÊS opções: profissional, pessoal ou incerto. Seja conservador - se não tiver certeza, classifique como INCERTO. Responda APENAS JSON.' 
                        },
                        { role: 'user', content: prompt }
                    ],
                    max_tokens: 150,
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                throw new Error('Groq API error');
            }

            const data = await response.json();
            const text = data.choices[0].message.content.trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                throw new Error('No JSON in response');
            }

            const result = JSON.parse(jsonMatch[0]);

            logger.info('IA analisou mensagem', {
                message: message.substring(0, 50),
                result
            });

            return result;

        } catch (error) {
            logger.error('Erro na análise IA', { 
                error: error.message,
                message: message.substring(0, 50)
            });
            return null;
        }
    }

    /**
     * Salva log de filtro no banco de dados (opcional)
     */
    async saveFilterLog(conversationId, phoneNumber, message, decision) {
        try {
            await db.query(
                `INSERT INTO message_filters 
                (conversation_id, telefone, mensagem, is_personal, confidence, reason, should_respond, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                [
                    conversationId,
                    phoneNumber,
                    message.substring(0, 500),
                    decision.isPersonal || false,
                    decision.analysis?.confidence || decision.confidence || 0,
                    decision.reason,
                    decision.shouldRespond
                ]
            );

            logger.debug('Log de filtro salvo', { conversationId });

        } catch (error) {
            if (!error.message.includes('relation "message_filters" does not exist')) {
                logger.debug('Tabela message_filters não existe (feature opcional)');
            }
        }
    }

    /**
     * 🆕 NOVO: Mensagem de esclarecimento quando há dúvida
     */
    getClarificationMessage() {
        return `Olá! 👋\n\n` +
               `Sou o assistente virtual da *Lopes Advocacia*.\n\n` +
               `Você precisa de ajuda com alguma questão jurídica? Por favor, me informe:\n\n` +
               `• 📋 Consulta sobre processo\n` +
               `• ⚖️ Orientação jurídica\n` +
               `• 📅 Agendamento de consulta\n` +
               `• 📄 Informações sobre serviços\n\n` +
               `Ou se for outro assunto, fique à vontade para me dizer! 😊`;
    }

    /**
     * 🆕 CORRIGIDO: Decide se o bot deve responder ou não
     * LÓGICA DEFINITIVA: Pergunta quando há dúvida
     */
    async shouldRespond(messageData, conversationHistory = []) {
        const {
            message,
            fromMe,
            isGroup,
            groupName,
            groupDescription,
            phoneNumber,
            conversationId
        } = messageData;

        // NUNCA responder mensagens próprias
        if (fromMe) {
            logger.debug('Ignorando mensagem própria');
            return { shouldRespond: false, reason: 'own_message' };
        }

        // Se for grupo, verificar se é grupo pessoal
        if (isGroup) {
            if (this.isPersonalGroup(groupName, groupDescription)) {
                logger.info('Ignorando grupo pessoal', { groupName });
                
                const decision = { 
                    shouldRespond: false, 
                    reason: 'personal_group',
                    groupName,
                    isPersonal: true
                };

                if (conversationId) {
                    await this.saveFilterLog(conversationId, phoneNumber, message, decision);
                }

                return decision;
            }

            logger.debug('Grupo detectado (não pessoal)', { groupName });
            return { 
                shouldRespond: true, 
                reason: 'professional_group',
                requiresMention: true
            };
        }

        // 🆕 BLOQUEIO PRIORITÁRIO: Serviços não-jurídicos (IPTV, streaming, etc)
        if (this.isNonLegalService(message)) {
            logger.info('Serviço não-jurídico bloqueado', {
                phoneNumber,
                message: message.substring(0, 80)
            });

            const decision = {
                shouldRespond: false,
                reason: 'non_legal_service',
                isPersonal: true,
                confidence: 1.0
            };

            if (conversationId) {
                await this.saveFilterLog(conversationId, phoneNumber, message, decision);
            }

            return decision;
        }

        // Análise por keywords
        const analysis = this.analyzeMessageContent(message, conversationHistory);

        // Se análise é ambígua (confidence < 0.5), usar IA
        if (analysis.confidence < 0.5 && process.env.GROQ_API_KEY) {
            logger.info('Análise ambígua - consultando IA', { 
                phoneNumber,
                scores: analysis.scores,
                confidence: analysis.confidence
            });

            const aiAnalysis = await this.analyzeWithAI(message, conversationHistory);
            
            if (aiAnalysis) {
                // 🆕 NOVA LÓGICA: Se IA diz "incerto", PERGUNTA
                if (aiAnalysis.classification === 'incerto') {
                    logger.info('IA está em dúvida - enviando pergunta de esclarecimento', { 
                        phoneNumber,
                        reason: aiAnalysis.reason
                    });

                    const decision = {
                        shouldRespond: true,
                        reason: 'uncertain_ask_clarification',
                        needsClarification: true,
                        clarificationMessage: this.getClarificationMessage(),
                        analysis: aiAnalysis,
                        confidence: aiAnalysis.confidence
                    };

                    if (conversationId) {
                        await this.saveFilterLog(conversationId, phoneNumber, message, decision);
                    }

                    return decision;
                }

                // Se IA diz "pessoal" com certeza, bloqueia
                if (aiAnalysis.classification === 'pessoal') {
                    logger.info('IA classificou como PESSOAL', { 
                        phoneNumber,
                        confidence: aiAnalysis.confidence,
                        reason: aiAnalysis.reason
                    });

                    const decision = {
                        shouldRespond: false,
                        reason: 'personal_conversation_ai',
                        analysis: aiAnalysis,
                        isPersonal: true,
                        confidence: aiAnalysis.confidence
                    };

                    if (conversationId) {
                        await this.saveFilterLog(conversationId, phoneNumber, message, decision);
                    }

                    return decision;
                }

                // Se IA diz "profissional", responde
                if (aiAnalysis.classification === 'profissional') {
                    logger.info('IA classificou como PROFISSIONAL', { 
                        phoneNumber,
                        confidence: aiAnalysis.confidence,
                        reason: aiAnalysis.reason
                    });

                    const decision = {
                        shouldRespond: true,
                        reason: 'professional_conversation_ai',
                        analysis: aiAnalysis,
                        isPersonal: false,
                        confidence: aiAnalysis.confidence
                    };

                    if (conversationId) {
                        await this.saveFilterLog(conversationId, phoneNumber, message, decision);
                    }

                    return decision;
                }
            }
        }

        // Decisão por keywords (quando confidence > 0.5)
        if (analysis.isPersonal && analysis.confidence > 0.5) {
            logger.info('Conversa pessoal detectada por keywords', {
                phoneNumber,
                confidence: analysis.confidence,
                scores: analysis.scores
            });

            const decision = {
                shouldRespond: false,
                reason: 'personal_conversation',
                analysis,
                isPersonal: true,
                confidence: analysis.confidence
            };

            if (conversationId) {
                await this.saveFilterLog(conversationId, phoneNumber, message, decision);
            }

            return decision;
        }

        // Se for profissional ou neutro, responder
        logger.debug('Conversa profissional ou neutra - respondendo', {
            phoneNumber,
            analysis
        });

        const decision = {
            shouldRespond: true,
            reason: analysis.isProfessional ? 'professional_conversation' : 'neutral_conversation',
            analysis,
            isPersonal: false,
            confidence: analysis.confidence
        };

        if (conversationId) {
            await this.saveFilterLog(conversationId, phoneNumber, message, decision);
        }

        return decision;
    }

    /**
     * Mensagem educada para quando não responder
     */
    getPoliteDeclineMessage() {
        const pessoal = process.env.ADVOGADO_PHONE_PESSOAL 
            ? `https://wa.me/${process.env.ADVOGADO_PHONE_PESSOAL}`
            : null;

        return `Olá! Sou o assistente jurídico da *Lopes Advocacia* 😊\n\n` +
            `Percebi que sua mensagem pode ser de cunho pessoal.\n\n` +
            `Caso sua mensagem seja sobre algum assunto jurídico, poderia me fornecer mais detalhes sobre o que deseja? Estou aqui para ajudar! ⚖️\n\n` +
            (pessoal 
                ? `Para assuntos pessoais com o Dr. Wanderson, acesse:\n${pessoal}`
                : `Para assuntos pessoais, entre em contato diretamente com o Dr. Wanderson.`);
    }

    /**
     * Adicionar palavra-chave personalizada
     */
    addCustomKeyword(keyword, type = 'personal') {
        if (type === 'personal') {
            this.personalKeywords.push(keyword.toLowerCase());
        } else {
            this.professionalKeywords.push(keyword.toLowerCase());
        }
        logger.info('Palavra-chave customizada adicionada', { keyword, type });
    }

    /**
     * Adicionar padrão de grupo personalizado
     */
    addCustomGroupPattern(pattern) {
        this.personalGroupPatterns.push(new RegExp(pattern, 'i'));
        logger.info('Padrão de grupo customizado adicionado', { pattern });
    }

    /**
     * Estatísticas de filtros
     */
    async getFilterStats(days = 7) {
        try {
            const result = await db.query(
                `SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN is_personal THEN 1 ELSE 0 END) as personal,
                    SUM(CASE WHEN NOT is_personal THEN 1 ELSE 0 END) as professional,
                    AVG(confidence) as avg_confidence
                FROM message_filters
                WHERE created_at >= NOW() - INTERVAL '${days} days'`
            );

            return result.rows[0];

        } catch (error) {
            logger.debug('Estatísticas não disponíveis (tabela pode não existir)');
            return null;
        }
    }
}

module.exports = new ConversationTypeDetector();