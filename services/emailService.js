const Imap = require('imap');
const { simpleParser } = require('mailparser');
const logger = require('../utils/logger');
const evolutionAPI = require('./evolutionAPI');
const processmovementnotifier = require('./Processmovementnotifier');

class EmailService {
    constructor() {
        this.isRunning = false;
        this.checkInterval = null;
        this.processedIds = new Set();

        this.config = {
            host: process.env.EMAIL_IMAP_HOST,
            port: parseInt(process.env.EMAIL_IMAP_PORT) || 993,
            user: process.env.EMAIL_USER,
            password: process.env.EMAIL_PASSWORD,
            tls: process.env.EMAIL_TLS !== 'false',
            tlsOptions: { rejectUnauthorized: false }
        };

        this.notifyPhone = process.env.EMAIL_NOTIFY_PHONE;
        this.checkIntervalMs = parseInt(process.env.EMAIL_CHECK_INTERVAL_MS) || 60000;
        this.projectName = process.env.COMPANY_NAME || 'Sistema';
    }

    async start() {
        if (!this.config.host || !this.config.user || !this.config.password) {
            logger.warn('📧 Email Service não configurado — variáveis ausentes');
            return;
        }
        if (!this.notifyPhone) {
            logger.warn('📧 EMAIL_NOTIFY_PHONE não configurado');
            return;
        }

        logger.info('📧 Email Service iniciando', {
            host: this.config.host,
            user: this.config.user,
            interval: `${this.checkIntervalMs / 1000}s`
        });

        await this.checkEmails();
        this.checkInterval = setInterval(() => this.checkEmails(), this.checkIntervalMs);
        this.isRunning = true;
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.isRunning = false;
        logger.info('📧 Email Service parado');
    }

    // ─── Busca via comando WhatsApp ───────────────────────────────────────────

    async handleWhatsAppCommand(message, fromPhone) {
        const msg = message.trim().toLowerCase();

        if (!msg.startsWith('#email')) return false;

        const command = msg.replace('#email', '').trim();

        await evolutionAPI.sendTextMessage(fromPhone, '🔍 Buscando e-mails...');

        let results = [];

        if (command.startsWith('de ')) {
            const sender = command.replace('de ', '').trim();
            results = await this.searchEmails({ from: sender });
        } else if (command.startsWith('assunto ')) {
            const subject = command.replace('assunto ', '').trim();
            results = await this.searchEmails({ subject });
        } else if (command === 'hoje') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            results = await this.searchEmails({ since: today });
        } else if (command.startsWith('buscar ')) {
            const keyword = command.replace('buscar ', '').trim();
            results = await this.searchEmails({ body: keyword });
        } else {
            await evolutionAPI.sendTextMessage(fromPhone,
                `📧 *Comandos disponíveis:*\n\n` +
                `• \`#email de fulano@email.com\`\n` +
                `• \`#email assunto contrato\`\n` +
                `• \`#email hoje\`\n` +
                `• \`#email buscar proposta\``
            );
            return true;
        }

        if (results.length === 0) {
            await evolutionAPI.sendTextMessage(fromPhone, '📭 Nenhum e-mail encontrado para essa busca.');
            return true;
        }

        const header = `📧 *${results.length} e-mail(s) encontrado(s):*\n\n`;
        const items = results.slice(0, 5).map((email, i) => {
            const date = email.date ? new Date(email.date).toLocaleDateString('pt-BR') : '?';
            return `*${i + 1}.* 👤 ${email.from}\n📋 ${email.subject}\n📅 ${date}\n💬 ${email.preview}`;
        }).join('\n\n─────────────\n\n');

        const footer = results.length > 5 ? `\n\n_...e mais ${results.length - 5} e-mail(s)_` : '';

        await evolutionAPI.sendTextMessage(fromPhone, header + items + footer);

        logger.info('📧 Busca de e-mail concluída via WhatsApp', {
            command,
            results: results.length,
            from: fromPhone
        });

        return true;
    }

    // ─── Busca IMAP genérica ──────────────────────────────────────────────────

    async searchEmails({ from, subject, since, body } = {}) {
        return new Promise((resolve) => {
            const imap = new Imap(this.config);
            const emails = [];

            imap.once('ready', () => {
                imap.openBox('INBOX', true, (err) => {
                    if (err) {
                        logger.error('Erro ao abrir inbox', { error: err.message });
                        imap.end();
                        return resolve([]);
                    }

                    const criteria = ['ALL'];
                    if (from) criteria.push(['FROM', from]);
                    if (subject) criteria.push(['SUBJECT', subject]);
                    if (since) criteria.push(['SINCE', since]);
                    if (body) criteria.push(['BODY', body]);

                    imap.search(criteria, (err, results) => {
                        if (err || !results || results.length === 0) {
                            imap.end();
                            return resolve([]);
                        }

                        const uids = results.slice(-10).filter(uid => uid != null);
                        if (uids.length === 0) {
                            imap.end();
                            return resolve([]);
                        }

                        const fetch = imap.fetch(uids, { bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)', 'TEXT'] });

                        fetch.on('message', (msg) => {
                            let header = '';
                            let bodyText = '';

                            msg.on('body', (stream, info) => {
                                let buffer = '';
                                stream.on('data', chunk => buffer += chunk.toString('utf8'));
                                stream.once('end', () => {
                                    if (info.which.includes('HEADER')) header = buffer;
                                    else bodyText = buffer;
                                });
                            });

                            msg.once('end', () => {
                                try {
                                    const fromMatch = header.match(/From: (.+)/i);
                                    const subjectMatch = header.match(/Subject: (.+)/i);
                                    const dateMatch = header.match(/Date: (.+)/i);
                                    emails.push({
                                        from: fromMatch ? fromMatch[1].trim() : 'Desconhecido',
                                        subject: subjectMatch ? subjectMatch[1].trim() : '(sem assunto)',
                                        date: dateMatch ? dateMatch[1].trim() : null,
                                        preview: bodyText.replace(/[^\w\s.,!?àáâãéêíóôõúüçÀÁÂÃÉÊÍÓÔÕÚÜÇ]/g, ' ').trim().substring(0, 120)
                                    });
                                } catch (e) {}
                            });
                        });

                        fetch.once('end', () => {
                            imap.end();
                            resolve(emails.reverse());
                        });

                        fetch.once('error', () => {
                            imap.end();
                            resolve([]);
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                logger.error('Erro na conexão IMAP', { error: err.message });
                resolve([]);
            });

            imap.once('end', () => {});
            imap.connect();
        });
    }

    // ─── Verificação automática de novos e-mails ──────────────────────────────

    async checkEmails() {
        return new Promise((resolve) => {
            const imap = new Imap(this.config);

            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err) => {
                    if (err) {
                        logger.error('Erro ao abrir caixa de entrada', { error: err.message });
                        imap.end();
                        return resolve();
                    }

                    const since = new Date();
                    since.setDate(since.getDate() - 2);

                    imap.search(['UNSEEN', ['SINCE', since]], async (err, results) => {
                        if (err || !results || results.length === 0) {
                            imap.end();
                            return resolve();
                        }

                        logger.info(`📧 ${results.length} e-mail(s) não lido(s) encontrado(s)`);

                        const validUids = results.filter(uid => uid != null);
                        if (validUids.length === 0) {
                            imap.end();
                            return resolve();
                        }

                        const fetch = imap.fetch(validUids, { bodies: '', uid: true });
                        const emails = [];

                        fetch.on('message', (msg) => {
                            let buffer = '';
                            let uid = null;

                            msg.on('attributes', (attrs) => {
                                uid = attrs.uid;
                            });

                            msg.on('body', (stream) => {
                                stream.on('data', chunk => buffer += chunk.toString('utf8'));
                            });

                            msg.once('end', () => {
                                if (uid != null) {
                                    emails.push({ buffer, uid });
                                }
                            });
                        });

                        fetch.once('end', async () => {
                            for (const email of emails) {
                                if (this.processedIds.has(email.uid)) continue;
                                try {
                                    const parsed = await simpleParser(email.buffer);
                                    await this.processEmail(parsed, email.uid);
                                    this.processedIds.add(email.uid);

                                    imap.addFlags(email.uid, ['\\Seen'], (err) => {
                                        if (err) logger.warn('Erro ao marcar como lido', { error: err.message });
                                    });
                                } catch (err) {
                                    logger.error('Erro ao processar e-mail', { error: err.message });
                                }
                            }
                            imap.end();
                            resolve();
                        });

                        fetch.once('error', (err) => {
                            logger.error('Erro no fetch', { error: err.message });
                            imap.end();
                            resolve();
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                logger.error('Erro na conexão IMAP', { error: err.message });
                resolve();
            });

            imap.once('end', () => resolve());
            imap.connect();
        });
    }

    // ─── Processamento de cada e-mail recebido ────────────────────────────────

    async processEmail(parsed, uid) {
        const from = parsed.from?.text || 'Remetente desconhecido';
        const subject = parsed.subject || '(sem assunto)';
        const body = parsed.text || parsed.html?.replace(/<[^>]*>/g, '') || '';
        const bodyPreview = body.substring(0, 300).trim();
        const messageId = parsed.messageId || `uid_${uid}`;

        logger.info('📧 Novo e-mail recebido', { from, subject });

        // ── 1. Tentar processar como movimentação processual ──────────────────
        try {
            const movimentacaoResult = await processmovementnotifier.processMovementEmail({
                subject,
                body,
                from,
                messageId
            });

            if (movimentacaoResult.processed) {
                // Movimentação tratada com sucesso — cliente e advogado já foram notificados
                logger.info('📧 Movimentacao processual tratada com sucesso', {
                    processNumber: movimentacaoResult.processNumber,
                    clientNotified: movimentacaoResult.clientNotified,
                    lawyerNotified: movimentacaoResult.lawyerNotified
                });
                return; // Não envia notificação genérica
            }

            // Processo não cadastrado no sistema — alerta especial para o advogado
            if (movimentacaoResult.reason === 'process_not_found') {
                logger.warn('📧 Processo não encontrado no banco', {
                    processNumber: movimentacaoResult.processNumber
                });
                const alertMsg =
                    `⚠️ *Movimentação — Processo NÃO Cadastrado*\n\n` +
                    `📋 Processo: ${movimentacaoResult.processNumber}\n` +
                    `👤 De: ${from}\n` +
                    `📋 Assunto: ${subject}\n\n` +
                    `_Este processo não está no sistema. Verifique e cadastre se necessário._`;
                await evolutionAPI.sendTextMessage(this.notifyPhone, alertMsg);
                return;
            }

            // Se chegou aqui, o e-mail não é de movimentação processual — cai no fluxo genérico

        } catch (movErr) {
            logger.error('📧 Erro ao tentar processar como movimentacao', { error: movErr.message });
            // Continua para o fluxo genérico
        }

        // ── 2. Fluxo genérico: classificar e decidir se notifica ─────────────
        const category = await this.categorizeEmail(subject, bodyPreview);

        // Marketing, newsletter e spam: marcar como lido e ignorar silenciosamente
        // (já marcado como lido no checkEmails — só logar e sair)
        if (!category.shouldNotify) {
            logger.info('📧 E-mail ignorado (categoria não relevante)', {
                type: category.type,
                subject,
                from
            });
            return;
        }

        // Notificar advogado apenas para categorias relevantes
        const emoji = this.getCategoryEmoji(category.type);

        const message =
            `${emoji} *Novo E-mail — ${this.projectName}*\n\n` +
            `📌 *Categoria:* ${category.label}\n` +
            `👤 *De:* ${from}\n` +
            `📋 *Assunto:* ${subject}\n` +
            `⚡ *Urgência:* ${category.urgency}\n\n` +
            `💬 *Resumo:*\n${category.summary}\n\n` +
            `_Use \`#email de ${from.match(/[\w.]+@[\w.]+/)?.[0] || 'remetente'}\` para ver mais e-mails deste contato._`;

        await evolutionAPI.sendTextMessage(this.notifyPhone, message);

        logger.info('📧 Notificação WhatsApp enviada', {
            to: this.notifyPhone,
            category: category.type,
            subject
        });
    }

    // ─── Categorização de e-mail genérico com IA ─────────────────────────────

    async categorizeEmail(subject, body) {
        try {
            const prompt = `Você classifica e-mails de um escritório de advocacia.
Responda APENAS em JSON válido, sem markdown:
{
  "type": "tribunal|cliente|urgente|financeiro|marketing|newsletter|spam|outro",
  "label": "Categoria em português",
  "urgency": "Alta|Média|Baixa",
  "summary": "Resumo em 1-2 frases",
  "shouldNotify": true/false
}

REGRAS OBRIGATÓRIAS para shouldNotify:
- true: tribunal, cliente, urgente, financeiro
- false: marketing, newsletter, spam, outro

CATEGORIAS:
- tribunal: e-mails de tribunais, DataJud, TRT, TRF, TJMA, intimações, citações, prazos
- cliente: contato de cliente atual ou potencial, solicitação de serviço jurídico
- urgente: qualquer assunto que exija ação imediata do advogado
- financeiro: honorários, pagamentos, notas fiscais, cobranças relacionadas ao escritório
- marketing: promoções, ofertas, publicidade, newsletters de empresas (ex: Balsamiq, RD Station)
- newsletter: informativos, boletins, conteúdo educativo sem ação necessária
- spam: lixo eletrônico, mensagens não solicitadas claramente irrelevantes
- outro: não se enquadra em nenhuma categoria acima

Assunto: \${subject}
Conteúdo: \${body.substring(0, 500)}`;

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.3
                })
            });

            if (!response.ok) throw new Error('Groq API error');

            const data = await response.json();
            const text = data.choices[0].message.content.trim();
            const clean = text.replace(/```json|```/g, '').trim();
            return JSON.parse(clean);
        } catch (err) {
            return {
                type: 'other',
                label: 'Geral',
                urgency: 'Média',
                summary: `E-mail recebido: ${subject}`
            };
        }
    }

    getCategoryEmoji(type) {
        const emojis = {
            tribunal:   '⚖️',
            cliente:    '👤',
            urgente:    '🚨',
            financeiro: '💰',
            marketing:  '📢',
            newsletter: '📰',
            spam:       '🗑️',
            outro:      '📧',
            // legados (compatibilidade)
            urgent: '🚨', commercial: '💼', support: '🛠️',
            legal: '⚖️', financial: '💰', other: '📧'
        };
        return emojis[type] || '📧';
    }
}

module.exports = new EmailService();