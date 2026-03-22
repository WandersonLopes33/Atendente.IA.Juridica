const dataJudService = require('./dataJudService');
const db = require('./database');
const logger = require('../utils/logger');

// Reutiliza funções já existentes no sistema
const emailService = require('./emailService');
const processmovementnotifier = require('./Processmovementnotifier');

/**
 * processoWhatsAppHandler.js
 *
 * Formas de consulta suportadas pela API Pública DataJud (CNJ):
 *  1. Por número do processo (CNJ NNNNNNN-DD.AAAA.J.TR.OOOO) ← principal
 *  2. Por nome da parte (campo partes.nome via Elasticsearch) ← fallback DataJud
 *
 * Quando o cliente não sabe o número, o sistema busca internamente em:
 *  A. Banco de dados → documentos já enviados pelo cliente (analise_ia + texto_extraido)
 *  B. Banco de dados → histórico de consultas anteriores (consultas_processuais)
 *  C. E-mails IMAP   → busca pelo nome do cliente usando emailService.searchEmails
 *                      + extrai número usando processmovementnotifier.extractProcessNumber
 *
 * NOTA: CPF não é exposto pela API pública (LGPD).
 */

class ProcessoWhatsAppHandler {

    isConsultaProcesso(mensagem) {
        const keywords = [
            'processo', 'andamento', 'movimentacao', 'movimentação',
            'justica', 'justiça', 'tribunal', 'juiz', 'vara',
            'sentenca', 'sentença', 'audiencia', 'audiência',
            'julgamento', 'decisao', 'decisão', 'intimacao', 'intimação'
        ];
        const lower = mensagem.toLowerCase();
        return keywords.some(k => lower.includes(k));
    }

    clienteNaoTemNumero(mensagem) {
        const lower = mensagem.toLowerCase();
        const padroes = [
            /n[ãa]o (tenho|sei|lembro|possuo|encontro|achei).{0,30}n[úu]mero/,
            /sem (o )?n[úu]mero/,
            /n[ãa]o (tenho|sei).{0,10}(processo|protocolo)/,
            /como (fa[çc]o|descubro|encontro|acho).{0,30}n[úu]mero/,
            /onde (fica|est[áa]|encontro|acho).{0,30}n[úu]mero/,
            /esqueci (o )?n[úu]mero/,
            /perdi (o )?n[úu]mero/,
        ];
        return padroes.some(p => p.test(lower));
    }

    extrairNumeroProcesso(mensagem) {
        const regexCNJ = /(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/;
        const matchCNJ = mensagem.match(regexCNJ);
        if (matchCNJ) return matchCNJ[1];

        const regexNumeros = /(\d{20})/;
        const matchNumeros = mensagem.match(regexNumeros);
        if (matchNumeros) {
            const n = matchNumeros[1];
            return `${n.substring(0,7)}-${n.substring(7,9)}.${n.substring(9,13)}.${n.substring(13,14)}.${n.substring(14,16)}.${n.substring(16,20)}`;
        }

        const regexGeral = /(\d{10,})/;
        const matchGeral = mensagem.match(regexGeral);
        return matchGeral ? matchGeral[1] : null;
    }

    async buscarAdvogado() {
        try {
            const result = await db.query(
                `SELECT * FROM advogados WHERE status = 'ativo' AND datajud_api_key IS NOT NULL LIMIT 1`
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Erro ao buscar advogado', { error: error.message });
            return null;
        }
    }

    async verificarSeClienteDoEscritorio(clienteId) {
        try {
            const result = await db.query(
                `SELECT c.id, c.nome, c.telefone, COUNT(p.id) as total_processos
                 FROM clientes c
                 LEFT JOIN processos p ON p.cliente_id = c.id
                 WHERE c.id = $1
                 GROUP BY c.id, c.nome, c.telefone`,
                [clienteId]
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Erro ao verificar cliente', { error: error.message });
            return null;
        }
    }

    async buscarProcessosNoBanco(clienteId) {
        try {
            const result = await db.query(
                `SELECT numero_processo, numero_cnj, situacao, ultima_movimentacao, area_direito
                 FROM processos WHERE cliente_id = $1 ORDER BY updated_at DESC LIMIT 5`,
                [clienteId]
            );
            return result.rows;
        } catch (error) {
            logger.error('Erro ao buscar processos no banco', { error: error.message });
            return [];
        }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // BUSCA INTEGRADA: procura o número do processo nas fontes internas
    //
    // Reutiliza módulos já existentes no sistema:
    //   - emailService.searchEmails()         → busca IMAP já implementada
    //   - processmovementnotifier.extractProcessNumber() → regex CNJ já implementada
    //
    // Fontes consultadas (em ordem de confiabilidade):
    //   1. documentos (banco) → analise_ia.numero_processo + regex no texto_extraido
    //   2. consultas_processuais (banco) → histórico de consultas anteriores
    //   3. e-mails IMAP → busca pelo nome do cliente + extração do número
    // ────────────────────────────────────────────────────────────────────────────
    async buscarNumeroProcessoNasFontes(clienteId, nomeCliente) {
        const numerosEncontrados = []; // [{ numero, fonte, detalhe }]

        // ── FONTE 1: Documentos enviados pelo cliente ─────────────────────────
        // Documentprocessor já extrai e salva analise_ia.numero_processo
        // e armazena o texto completo em texto_extraido
        try {
            const docsResult = await db.query(
                `SELECT filename_original, analise_ia, texto_extraido, created_at
                 FROM documentos WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 20`,
                [clienteId]
            );

            for (const doc of docsResult.rows) {
                // 1a. Campo analise_ia.numero_processo (já extraído pela IA)
                if (doc.analise_ia) {
                    try {
                        const analise = typeof doc.analise_ia === 'string'
                            ? JSON.parse(doc.analise_ia) : doc.analise_ia;
                        if (analise.numero_processo) {
                            const num = this.extrairNumeroProcesso(analise.numero_processo);
                            if (num && !numerosEncontrados.find(n => n.numero === num)) {
                                numerosEncontrados.push({
                                    numero: num,
                                    fonte: 'documento',
                                    detalhe: `encontrado no arquivo _${doc.filename_original}_`
                                });
                            }
                        }
                    } catch (_) {}
                }

                // 1b. Fallback: regex no texto_extraido
                if (doc.texto_extraido) {
                    const matches = doc.texto_extraido.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g) || [];
                    for (const num of matches) {
                        if (!numerosEncontrados.find(n => n.numero === num)) {
                            numerosEncontrados.push({
                                numero: num,
                                fonte: 'documento',
                                detalhe: `encontrado no texto do arquivo _${doc.filename_original}_`
                            });
                        }
                    }
                }
            }

            logger.info('Busca em documentos concluída', {
                clienteId, docsAnalisados: docsResult.rows.length,
                encontrados: numerosEncontrados.length
            });
        } catch (error) {
            logger.warn('Erro ao buscar em documentos', { error: error.message });
        }

        // ── FONTE 2: Histórico de consultas anteriores ────────────────────────
        // Tabela consultas_processuais guarda todo número já consultado
        try {
            const consultasResult = await db.query(
                `SELECT DISTINCT cp.numero_processo, cp.created_at
                 FROM consultas_processuais cp
                 INNER JOIN processos p ON p.id = cp.processo_id
                 WHERE p.cliente_id = $1
                 ORDER BY cp.created_at DESC LIMIT 5`,
                [clienteId]
            );

            for (const consulta of consultasResult.rows) {
                const num = this.extrairNumeroProcesso(consulta.numero_processo);
                if (num && !numerosEncontrados.find(n => n.numero === num)) {
                    const data = new Date(consulta.created_at).toLocaleDateString('pt-BR');
                    numerosEncontrados.push({
                        numero: num,
                        fonte: 'historico',
                        detalhe: `consultado anteriormente em ${data}`
                    });
                }
            }

            logger.info('Busca em histórico concluída', {
                clienteId, encontrados: numerosEncontrados.length
            });
        } catch (error) {
            logger.warn('Erro ao buscar em histórico de consultas', { error: error.message });
        }

        // ── FONTE 3: E-mails IMAP ─────────────────────────────────────────────
        // Reutiliza emailService.searchEmails (já existente no sistema)
        // Extrai número com processmovementnotifier.extractProcessNumber (já existente)
        // Só executa se as fontes anteriores não retornaram nada (evita requisição IMAP desnecessária)
        if (nomeCliente && nomeCliente !== 'Cliente' && numerosEncontrados.length === 0) {
            try {
                logger.info('Buscando número do processo nos e-mails IMAP', { nomeCliente });

                const since90Days = new Date();
                since90Days.setDate(since90Days.getDate() - 90);

                // Usa a função já existente no emailService
                const emailsEncontrados = await emailService.searchEmails({
                    body: nomeCliente,
                    since: since90Days
                });

                for (const email of emailsEncontrados) {
                    const textoCompleto = `${email.subject} ${email.preview}`;
                    // Usa a função já existente no processmovementnotifier
                    const numero = processmovementnotifier.extractProcessNumber(textoCompleto);

                    if (numero && !numerosEncontrados.find(n => n.numero === numero)) {
                        numerosEncontrados.push({
                            numero,
                            fonte: 'email',
                            detalhe: `encontrado no e-mail: _"${email.subject}"_`
                        });
                    }
                }

                logger.info('Busca em e-mails concluída', {
                    nomeCliente,
                    emailsAnalisados: emailsEncontrados.length,
                    encontrados: numerosEncontrados.length
                });
            } catch (error) {
                logger.warn('Erro ao buscar em e-mails', { error: error.message });
            }
        }

        return numerosEncontrados;
    }

    async buscarPorNomeNaDataJud(nomeCliente, advogado) {
        try {
            dataJudService.initialize({
                datajud_api_key: advogado.datajud_api_key,
                datajud_certificado: advogado.datajud_certificado
            });

            const tribunal = process.env.DATAJUD_TRIBUNAL || 'tjma';
            const url = `${process.env.DATAJUD_API_URL}/api_publica_${tribunal}/_search`;

            const body = {
                query: {
                    nested: {
                        path: 'partes',
                        query: {
                            match: { 'partes.nome': { query: nomeCliente, fuzziness: 'AUTO' } }
                        }
                    }
                },
                size: 3,
                sort: [{ dataHoraUltimaAtualizacao: { order: 'desc' } }]
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `APIKey ${advogado.datajud_api_key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) return [];

            const data = await response.json();
            return (data.hits?.hits || []).map(h => ({
                numero_processo: h._source.numeroProcesso,
                situacao: h._source.situacaoProcesso,
                classe: h._source.classe?.nome,
                orgao: h._source.orgaoJulgador?.nome
            }));
        } catch (error) {
            logger.error('Erro na busca por nome no DataJud', { error: error.message });
            return [];
        }
    }

    async consultarEsalvar(numeroProcesso, advogado, clienteId, conversationId) {
        try {
            dataJudService.initialize({
                datajud_api_key: advogado.datajud_api_key,
                datajud_certificado: advogado.datajud_certificado
            });

            const dados = await dataJudService.consultarProcesso(numeroProcesso);
            const existe = await db.query(
                `SELECT id FROM processos WHERE numero_cnj = $1 AND advogado_id = $2`,
                [dados.numeroCNJ || numeroProcesso, advogado.id]
            );

            let processoId;

            if (existe.rows.length > 0) {
                processoId = existe.rows[0].id;
                await db.query(
                    `UPDATE processos SET situacao=$1, ultima_movimentacao=$2, ultimo_check=NOW(), updated_at=NOW() WHERE id=$3`,
                    [dados.situacao, dados.movimentacoes[0]?.data || null, processoId]
                );
            } else {
                const insert = await db.query(
                    `INSERT INTO processos (
                        advogado_id, cliente_id, conversation_id,
                        numero_processo, numero_cnj, tribunal, instancia,
                        vara, comarca, juiz, situacao, classe_processual, assunto,
                        data_distribuicao, valor_causa, autor, reu, outros_envolvidos,
                        ultimo_check, ultima_movimentacao
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),$19)
                    RETURNING id`,
                    [
                        advogado.id, clienteId, conversationId,
                        numeroProcesso, dados.numeroCNJ || numeroProcesso,
                        dados.tribunal, dados.instancia, dados.orgaoJulgador, dados.comarca, dados.juiz,
                        dados.situacao, dados.classe, dados.assunto, dados.dataDistribuicao, dados.valorCausa,
                        JSON.stringify(dados.partes?.autor || []), JSON.stringify(dados.partes?.reu || []),
                        JSON.stringify(dados.partes?.outros || []), dados.movimentacoes[0]?.data || null
                    ]
                );
                processoId = insert.rows[0].id;

                for (const mov of (dados.movimentacoes || []).slice(0, 5)) {
                    await db.query(
                        `INSERT INTO movimentacoes (processo_id, data_movimentacao, tipo, codigo_movimento, titulo, descricao, conteudo_completo, prioridade, categoria)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                        [processoId, mov.data, mov.tipo, mov.codigo, mov.tipo, mov.descricao, mov.conteudo, mov.prioridade, mov.categoria]
                    ).catch(() => {});
                }
            }

            await db.query(
                `INSERT INTO consultas_processuais (advogado_id, processo_id, numero_processo, tipo_consulta, fonte, sucesso, tempo_resposta_ms)
                 VALUES ($1,$2,$3,'manual','datajud',true,$4)`,
                [advogado.id, processoId, numeroProcesso, dados.tempoResposta || 0]
            ).catch(() => {});

            return { sucesso: true, dados, processoId };
        } catch (error) {
            logger.error('Erro ao consultar/salvar processo', { numeroProcesso, error: error.message });
            await db.query(
                `INSERT INTO consultas_processuais (advogado_id, numero_processo, tipo_consulta, fonte, sucesso, erro)
                 VALUES ($1,$2,'manual','datajud',false,$3)`,
                [advogado?.id, numeroProcesso, error.message]
            ).catch(() => {});
            return { sucesso: false, erro: error.message };
        }
    }

    formatarResposta(dados, numeroProcesso) {
        const movs = dados.movimentacoes || [];
        const ultima = movs[0];
        const dataConsulta = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        let msg = `⚖️ *CONSULTA PROCESSUAL*\n\n`;
        msg += `📋 *Processo:* ${numeroProcesso}\n`;
        msg += `📊 *Situação:* ${dados.situacao || 'Não informada'}\n`;
        if (dados.juiz) msg += `👨‍⚖️ *Juiz:* ${dados.juiz}\n`;
        if (dados.orgaoJulgador) msg += `🏛️ *Vara:* ${dados.orgaoJulgador}\n`;
        if (dados.comarca) msg += `📍 *Comarca:* ${dados.comarca}\n`;

        if (ultima) {
            const dataMovimento = ultima.data ? new Date(ultima.data).toLocaleDateString('pt-BR') : 'Não informada';
            msg += `\n📅 *Última movimentação:*\n`;
            msg += `• Data: ${dataMovimento}\n`;
            msg += `• Tipo: ${ultima.tipo || 'Não informado'}\n`;
            if (ultima.descricao) msg += `• Descrição: ${ultima.descricao}\n`;
        }

        msg += `\n_Consulta realizada em ${dataConsulta}_`;
        msg += `\n_Para mais detalhes, fale com o Dr. Wanderson Mailson._`;
        return msg;
    }

    async processar(mensagem, conversationId, clienteId, telefone) {
        try {
            if (!this.isConsultaProcesso(mensagem)) return null;

            logger.info('Consulta processual detectada', { conversationId, telefone });

            // ── 1. Verificação: é cliente do escritório? ──────────────────────
            const dadosCliente = clienteId
                ? await this.verificarSeClienteDoEscritorio(clienteId)
                : null;

            const isClienteCadastrado = dadosCliente && parseInt(dadosCliente.total_processos) > 0;

            if (!isClienteCadastrado) {
                logger.info('Solicitante não é cliente com processo — encaminhando como novo', {
                    conversationId, telefone,
                    clienteExiste: !!dadosCliente,
                    totalProcessos: dadosCliente?.total_processos || 0
                });
                return {
                    sucesso: false,
                    novoCliente: true,
                    situacao: 'processo_novo_cliente',
                    dados: {}
                };
            }

            // ── 2. Cliente não tem o número → busca nas fontes internas ──────
            if (this.clienteNaoTemNumero(mensagem)) {
                logger.info('Cliente não tem o número — buscando nas fontes internas', {
                    conversationId, clienteId, nomeCliente: dadosCliente.nome
                });

                // 2a. Processos já no banco (instantâneo)
                const processosNoBanco = await this.buscarProcessosNoBanco(clienteId);
                if (processosNoBanco.length > 0) {
                    return {
                        sucesso: true,
                        situacao: 'processos_no_banco',
                        dados: { processos: processosNoBanco }
                    };
                }

                // 2b. Busca integrada: documentos + histórico + e-mails
                await sendTypingHelper(telefone, true);
                const numerosEncontrados = await this.buscarNumeroProcessoNasFontes(
                    clienteId, dadosCliente.nome
                );
                await sendTypingHelper(telefone, false);

                if (numerosEncontrados.length > 0) {
                    return {
                        sucesso: true,
                        situacao: 'numeros_encontrados_fontes',
                        dados: { numerosEncontrados }
                    };
                }

                // 2c. Nada nas fontes internas → tenta DataJud por nome
                const advogadoBusca = await this.buscarAdvogado();
                if (advogadoBusca && dadosCliente.nome && dadosCliente.nome !== 'Cliente') {
                    const processosPorNome = await this.buscarPorNomeNaDataJud(dadosCliente.nome, advogadoBusca);
                    if (processosPorNome.length > 0) {
                        return {
                            sucesso: true,
                            situacao: 'processos_encontrados_datajud_nome',
                            dados: { processosPorNome, nomeCliente: dadosCliente.nome }
                        };
                    }
                }

                // 2d. Nada encontrado em nenhuma fonte
                return {
                    sucesso: false,
                    situacao: 'processo_nao_encontrado_fontes',
                    dados: {}
                };
            }

            // ── 3. Cliente com número → consultar DataJud ─────────────────────
            const numeroProcesso = this.extrairNumeroProcesso(mensagem);

            if (!numeroProcesso) {
                return { sucesso: false, situacao: 'processo_numero_invalido', dados: {} };
            }

            const advogado = await this.buscarAdvogado();
            if (!advogado) {
                return { sucesso: false, situacao: 'processo_sem_api', dados: {} };
            }

            const resultado = await this.consultarEsalvar(numeroProcesso, advogado, clienteId, conversationId);

            if (!resultado.sucesso) {
                return {
                    sucesso: false,
                    situacao: 'processo_nao_encontrado',
                    dados: { numeroProcesso }
                };
            }

            return {
                sucesso: true,
                situacao: 'processo_encontrado',
                dados: resultado.dados,
                numeroProcesso,
                processoId: resultado.processoId
            };

        } catch (error) {
            logger.error('Erro ao processar consulta processual', { error: error.message });
            return { sucesso: false, situacao: 'processo_sem_api', dados: {} };
        }
    }
}

// Helper local para typing (evita dependência circular com evolutionAPI)
async function sendTypingHelper(telefone, estado) {
    try {
        const evolutionAPI = require('./evolutionAPI');
        await evolutionAPI.sendTyping(telefone, estado);
    } catch (_) {}
}

module.exports = new ProcessoWhatsAppHandler();