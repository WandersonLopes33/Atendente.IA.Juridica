-- ============================================================
-- MIGRAÇÃO COMPLETA — Backend Jurídico (Lopes Advocacia)
-- Rodar no banco PostgreSQL do Railway
-- ============================================================

-- ── Extensões ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Clientes ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telefone    VARCHAR(20) UNIQUE NOT NULL,
    nome        VARCHAR(200),
    email       VARCHAR(200),
    cpf         VARCHAR(14),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Advogados ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advogados (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome            VARCHAR(200) NOT NULL,
    oab             VARCHAR(50),
    telefone        VARCHAR(20),
    email           VARCHAR(200),
    datajud_api_key TEXT,
    status          VARCHAR(20) DEFAULT 'ativo',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Conversations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id              UUID REFERENCES clientes(id) ON DELETE SET NULL,
    telefone                VARCHAR(20),
    status                  VARCHAR(20) DEFAULT 'active',
    ultimo_estado           VARCHAR(100),
    transferido_para_humano BOOLEAN DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Adicionar colunas que podem estar faltando (idempotente)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ultimo_estado VARCHAR(100);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS transferido_para_humano BOOLEAN DEFAULT FALSE;

-- ── Messages ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    sender          VARCHAR(20) NOT NULL,
    conteudo        TEXT NOT NULL,
    tipo            VARCHAR(50) DEFAULT 'text',
    timestamp       TIMESTAMPTZ DEFAULT NOW(),
    metadata        JSONB
);

-- ── Processos ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
    advogado_id     UUID REFERENCES advogados(id) ON DELETE SET NULL,
    numero_processo VARCHAR(50),
    tipo_acao       VARCHAR(200),
    status          VARCHAR(50) DEFAULT 'ativo',
    tribunal        VARCHAR(100),
    vara            VARCHAR(100),
    dados_datajud   JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Documentos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documentos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
    cliente_id          UUID REFERENCES clientes(id) ON DELETE SET NULL,
    processo_id         UUID REFERENCES processos(id) ON DELETE SET NULL,
    filename_original   VARCHAR(500),
    filename_sistema    VARCHAR(500),
    filepath            TEXT,
    tipo_documento      VARCHAR(100),
    texto_extraido      TEXT,
    analise_ia          JSONB,
    filesize            INTEGER,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Consultas processuais ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS consultas_processuais (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    cliente_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
    numero_processo VARCHAR(50),
    resultado       JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Movimentações ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS movimentacoes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    processo_id     UUID REFERENCES processos(id) ON DELETE CASCADE,
    descricao       TEXT,
    data_moviment   TIMESTAMPTZ,
    notificado      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Casos em coleta ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS casos_em_coleta (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    cliente_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
    dados           JSONB DEFAULT '{}',
    status          VARCHAR(20) DEFAULT 'em_coleta',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Agenda ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    descricao           TEXT NOT NULL,
    data_hora           TIMESTAMPTZ NOT NULL,
    local               VARCHAR(500),
    cliente_id          UUID REFERENCES clientes(id) ON DELETE SET NULL,
    status              VARCHAR(20) DEFAULT 'ativo',
    alerta_1d_enviado   BOOLEAN DEFAULT FALSE,
    alerta_1h_enviado   BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Chat advogado IA ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_advogado (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    remetente   VARCHAR(20) NOT NULL,
    conteudo    TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Orientações da IA ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orientacoes_ia (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID REFERENCES clientes(id) ON DELETE SET NULL,
    conteudo    TEXT NOT NULL,
    ativa       BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Settings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chave   VARCHAR(100) UNIQUE NOT NULL,
    valor   TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Analytics ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(100),
    conversation_id UUID,
    cliente_id      UUID,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Índices para performance ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_telefone  ON conversations(telefone);
CREATE INDEX IF NOT EXISTS idx_conversations_status    ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation   ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp      ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_clientes_telefone       ON clientes(telefone);
CREATE INDEX IF NOT EXISTS idx_processos_cliente       ON processos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_agenda_data_hora        ON agenda(data_hora);

-- ── Inserir advogado padrão ───────────────────────────────────
INSERT INTO advogados (nome, oab, telefone, email, status)
VALUES (
    'Wanderson Mailson Machado Lopes',
    'MA-00000',
    '5599982277074',
    'adv.wanderson.lopes33@gmail.com',
    'ativo'
)
ON CONFLICT DO NOTHING;

-- ── Verificar resultado ───────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
