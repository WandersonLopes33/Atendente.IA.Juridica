-- =====================================================
-- SISTEMA JURÍDICO - SCHEMA COMPLETO
-- Integração com DataJud CNJ para Monitoramento Processual
-- =====================================================

-- Criar extensão UUID (se não existir)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- TABELA: advogados
-- Armazena dados dos advogados e suas credenciais API
-- =====================================================
CREATE TABLE IF NOT EXISTS advogados (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome VARCHAR(255) NOT NULL,
    oab VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(255),
    telefone VARCHAR(20),
    
    -- Credenciais DataJud CNJ
    datajud_api_key TEXT,
    datajud_certificado TEXT, -- Base64 do certificado digital A1/A3
    datajud_senha_certificado TEXT, -- Criptografada
    
    -- Configurações
    tribunais_atuacao JSONB DEFAULT '[]'::jsonb, -- ["TJ-MA", "TJ-SP", "TRF1"]
    notificacoes_ativas BOOLEAN DEFAULT TRUE,
    horario_notificacao_inicio TIME DEFAULT '08:00',
    horario_notificacao_fim TIME DEFAULT '20:00',
    
    status VARCHAR(20) DEFAULT 'ativo', -- ativo, inativo, suspenso
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_advogados_oab ON advogados(oab);
CREATE INDEX idx_advogados_status ON advogados(status);

-- =====================================================
-- TABELA: processos
-- Processos judiciais monitorados
-- =====================================================
CREATE TABLE IF NOT EXISTS processos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    advogado_id UUID REFERENCES advogados(id) ON DELETE CASCADE,
    numero_processo VARCHAR(25) NOT NULL,
    numero_cnj VARCHAR(25), -- Formato CNJ padronizado NNNNNNN-DD.AAAA.J.TT.OOOO
    
    -- Dados do processo
    tribunal VARCHAR(10), -- TJ-MA, TRF1, TST, STJ, STF
    instancia VARCHAR(20), -- 1ª instância, 2ª instância, STJ, STF
    vara VARCHAR(200),
    comarca VARCHAR(100),
    juiz VARCHAR(200),
    situacao VARCHAR(50),
    classe_processual VARCHAR(100),
    assunto VARCHAR(500),
    
    -- Partes (armazenadas como JSON para flexibilidade)
    autor TEXT,
    reu TEXT,
    outros_envolvidos JSONB,
    
    -- Controle
    data_distribuicao DATE,
    valor_causa DECIMAL(15,2),
    ultimo_check TIMESTAMP,
    ultima_movimentacao TIMESTAMP,
    notificacoes_ativas BOOLEAN DEFAULT TRUE,
    prioridade VARCHAR(20) DEFAULT 'normal', -- urgente, alta, normal, baixa
    
    -- Vinculação com cliente (opcional)
    cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(advogado_id, numero_cnj)
);

CREATE INDEX idx_processos_advogado ON processos(advogado_id);
CREATE INDEX idx_processos_numero ON processos(numero_processo);
CREATE INDEX idx_processos_numero_cnj ON processos(numero_cnj);
CREATE INDEX idx_processos_ultimo_check ON processos(ultimo_check);
CREATE INDEX idx_processos_cliente ON processos(cliente_id);
CREATE INDEX idx_processos_prioridade ON processos(prioridade);

-- =====================================================
-- TABELA: movimentacoes
-- Movimentações processuais (andamentos)
-- =====================================================
CREATE TABLE IF NOT EXISTS movimentacoes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
    
    data_movimentacao TIMESTAMP NOT NULL,
    tipo VARCHAR(100),
    codigo_movimento VARCHAR(20), -- Código da tabela CNJ de movimentos
    titulo VARCHAR(500),
    descricao TEXT,
    conteudo_completo TEXT,
    
    -- Classificação automática pela IA
    prioridade VARCHAR(20) DEFAULT 'normal', -- urgente, alta, normal, baixa, informativo
    categoria VARCHAR(50), -- sentenca, despacho, decisao, peticao, citacao, intimacao, juntada, audiencia
    requer_acao BOOLEAN DEFAULT FALSE,
    prazo_dias INTEGER,
    
    -- Controle de notificação
    notificado BOOLEAN DEFAULT FALSE,
    notificado_em TIMESTAMP,
    visualizado BOOLEAN DEFAULT FALSE,
    visualizado_em TIMESTAMP,
    
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_movimentacoes_processo ON movimentacoes(processo_id);
CREATE INDEX idx_movimentacoes_data ON movimentacoes(data_movimentacao DESC);
CREATE INDEX idx_movimentacoes_notificado ON movimentacoes(notificado) WHERE NOT notificado;
CREATE INDEX idx_movimentacoes_prioridade ON movimentacoes(prioridade);
CREATE INDEX idx_movimentacoes_categoria ON movimentacoes(categoria);

-- =====================================================
-- TABELA: consultas_processuais
-- Log de consultas realizadas (auditoria e análise)
-- =====================================================
CREATE TABLE IF NOT EXISTS consultas_processuais (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    advogado_id UUID REFERENCES advogados(id) ON DELETE SET NULL,
    processo_id UUID REFERENCES processos(id) ON DELETE SET NULL,
    numero_processo VARCHAR(25),
    
    tipo_consulta VARCHAR(50), -- manual, automatica, webhook
    fonte VARCHAR(50), -- datajud, pje, projudi, cache
    sucesso BOOLEAN,
    tempo_resposta_ms INTEGER,
    erro TEXT,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_consultas_advogado ON consultas_processuais(advogado_id);
CREATE INDEX idx_consultas_processo ON consultas_processuais(processo_id);
CREATE INDEX idx_consultas_data ON consultas_processuais(created_at DESC);

-- =====================================================
-- TABELA: configuracoes_notificacao
-- Preferências de notificação do advogado
-- =====================================================
CREATE TABLE IF NOT EXISTS configuracoes_notificacao (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    advogado_id UUID REFERENCES advogados(id) ON DELETE CASCADE,
    
    -- Tipos de movimentação que geram notificação
    notificar_sentenca BOOLEAN DEFAULT TRUE,
    notificar_decisao BOOLEAN DEFAULT TRUE,
    notificar_despacho BOOLEAN DEFAULT TRUE,
    notificar_citacao BOOLEAN DEFAULT TRUE,
    notificar_intimacao BOOLEAN DEFAULT TRUE,
    notificar_peticao BOOLEAN DEFAULT FALSE,
    notificar_juntada BOOLEAN DEFAULT FALSE,
    notificar_audiencia BOOLEAN DEFAULT TRUE,
    
    -- Apenas movimentações urgentes/importantes
    apenas_urgentes BOOLEAN DEFAULT FALSE,
    
    -- Canais de notificação
    notificar_whatsapp BOOLEAN DEFAULT TRUE,
    notificar_email BOOLEAN DEFAULT TRUE,
    notificar_sms BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(advogado_id)
);

-- =====================================================
-- TRIGGERS - Atualizar updated_at automaticamente
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_advogados_updated_at
    BEFORE UPDATE ON advogados
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_processos_updated_at
    BEFORE UPDATE ON processos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_configuracoes_notificacao_updated_at
    BEFORE UPDATE ON configuracoes_notificacao
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- VIEWS - Consultas úteis pré-definidas
-- =====================================================

-- Processos com movimentações recentes
CREATE OR REPLACE VIEW v_processos_ativos AS
SELECT 
    p.id,
    p.numero_processo,
    p.numero_cnj,
    p.tribunal,
    p.situacao,
    a.nome as advogado_nome,
    a.oab as advogado_oab,
    p.ultima_movimentacao,
    COUNT(m.id) as total_movimentacoes,
    COUNT(m.id) FILTER (WHERE NOT m.notificado) as movimentacoes_pendentes
FROM processos p
INNER JOIN advogados a ON p.advogado_id = a.id
LEFT JOIN movimentacoes m ON p.id = m.processo_id
WHERE p.notificacoes_ativas = TRUE
GROUP BY p.id, p.numero_processo, p.numero_cnj, p.tribunal, p.situacao, 
         a.nome, a.oab, p.ultima_movimentacao
ORDER BY p.ultima_movimentacao DESC NULLS LAST;

-- Movimentações não notificadas
CREATE OR REPLACE VIEW v_movimentacoes_pendentes AS
SELECT 
    m.*,
    p.numero_processo,
    p.numero_cnj,
    a.nome as advogado_nome,
    a.telefone as advogado_telefone,
    c.telefone as cliente_telefone
FROM movimentacoes m
INNER JOIN processos p ON m.processo_id = p.id
INNER JOIN advogados a ON p.advogado_id = a.id
LEFT JOIN clientes c ON p.cliente_id = c.id
WHERE m.notificado = FALSE
  AND p.notificacoes_ativas = TRUE
ORDER BY m.prioridade DESC, m.data_movimentacao DESC;

-- Estatísticas por advogado
CREATE OR REPLACE VIEW v_estatisticas_advogado AS
SELECT 
    a.id,
    a.nome,
    a.oab,
    COUNT(DISTINCT p.id) as total_processos,
    COUNT(DISTINCT p.id) FILTER (WHERE p.notificacoes_ativas) as processos_monitorados,
    COUNT(m.id) as total_movimentacoes,
    COUNT(m.id) FILTER (WHERE m.created_at >= NOW() - INTERVAL '30 days') as movimentacoes_mes,
    COUNT(m.id) FILTER (WHERE m.prioridade = 'urgente') as movimentacoes_urgentes
FROM advogados a
LEFT JOIN processos p ON a.id = p.advogado_id
LEFT JOIN movimentacoes m ON p.id = m.processo_id
WHERE a.status = 'ativo'
GROUP BY a.id, a.nome, a.oab;

-- =====================================================
-- DADOS INICIAIS (OPCIONAL)
-- =====================================================

-- Exemplo de advogado (REMOVA EM PRODUÇÃO)
-- INSERT INTO advogados (nome, oab, email, telefone) VALUES
-- ('Dr. Wanderson Lopes', 'MA12345', 'adv.wanderson.lopes33@gmail.com', '5599982277074');

-- =====================================================
-- COMENTÁRIOS
-- =====================================================

COMMENT ON TABLE advogados IS 'Cadastro de advogados com credenciais DataJud';
COMMENT ON TABLE processos IS 'Processos judiciais monitorados automaticamente';
COMMENT ON TABLE movimentacoes IS 'Andamentos processuais (movimentações)';
COMMENT ON TABLE consultas_processuais IS 'Log de consultas à API DataJud';
COMMENT ON TABLE configuracoes_notificacao IS 'Preferências de notificação por advogado';

COMMENT ON COLUMN processos.numero_cnj IS 'Número no formato CNJ: NNNNNNN-DD.AAAA.J.TT.OOOO';
COMMENT ON COLUMN movimentacoes.codigo_movimento IS 'Código da Tabela Única de Movimentos do CNJ';
COMMENT ON COLUMN movimentacoes.prioridade IS 'Classificação automática pela IA';

-- =====================================================
-- VERIFICAÇÕES FINAIS
-- =====================================================

-- Listar tabelas criadas
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_tables
WHERE tablename IN ('advogados', 'processos', 'movimentacoes', 'consultas_processuais', 'configuracoes_notificacao')
ORDER BY tablename;

-- Verificar índices
SELECT 
    tablename,
    indexname
FROM pg_indexes
WHERE tablename LIKE '%process%' OR tablename LIKE '%advogado%' OR tablename LIKE '%moviment%'
ORDER BY tablename, indexname;

SELECT '✅ Schema de Processos Judiciais criado com sucesso!' as status;