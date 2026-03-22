-- =====================================================
-- VIAGEMEXPRESS - SCHEMA DO BANCO DE DADOS
-- Sistema de Atendimento WhatsApp com IA
-- =====================================================

-- Criar extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- TABELA: conversations
-- Armazena as conversas com os clientes
-- =====================================================
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(20) NOT NULL,
    customer_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived', 'transferred')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_conversations_phone ON conversations(phone_number);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_created_at ON conversations(created_at);

-- =====================================================
-- TABELA: messages
-- Armazena todas as mensagens das conversas
-- =====================================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    sender VARCHAR(20) NOT NULL CHECK (sender IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document', 'location', 'contact')),
    is_manual BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_sender ON messages(sender);

-- =====================================================
-- TABELA: orders
-- Armazena os pedidos de passagens
-- =====================================================
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    phone_number VARCHAR(20) NOT NULL,
    customer_name VARCHAR(255),
    customer_cpf VARCHAR(14),
    origin VARCHAR(255) NOT NULL,
    destination VARCHAR(255) NOT NULL,
    travel_date DATE NOT NULL,
    departure_time TIME,
    passengers INTEGER DEFAULT 1,
    total_amount DECIMAL(10, 2),
    payment_method VARCHAR(50),
    payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'cancelled', 'refunded')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_orders_conversation ON orders(conversation_id);
CREATE INDEX idx_orders_phone ON orders(phone_number);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_payment_status ON orders(payment_status);
CREATE INDEX idx_orders_travel_date ON orders(travel_date);
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- =====================================================
-- TABELA: analytics_events
-- Armazena eventos para análise
-- =====================================================
CREATE TABLE IF NOT EXISTS analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_analytics_conversation ON analytics_events(conversation_id);
CREATE INDEX idx_analytics_type ON analytics_events(event_type);
CREATE INDEX idx_analytics_created_at ON analytics_events(created_at);

-- =====================================================
-- TABELA: system_settings
-- Configurações do sistema
-- =====================================================
CREATE TABLE IF NOT EXISTS system_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_settings_key ON system_settings(key);

-- =====================================================
-- VIEWS: Estatísticas úteis
-- =====================================================

-- View de conversas por status
CREATE OR REPLACE VIEW v_conversations_by_status AS
SELECT 
    status,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as last_24h,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as last_7days
FROM conversations
GROUP BY status;

-- View de mensagens por dia
CREATE OR REPLACE VIEW v_messages_by_day AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_messages,
    COUNT(*) FILTER (WHERE sender = 'user') as user_messages,
    COUNT(*) FILTER (WHERE sender = 'assistant') as assistant_messages
FROM messages
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- View de pedidos por status
CREATE OR REPLACE VIEW v_orders_by_status AS
SELECT 
    status,
    payment_status,
    COUNT(*) as total,
    SUM(total_amount) as total_revenue,
    AVG(total_amount) as avg_ticket
FROM orders
GROUP BY status, payment_status;

-- =====================================================
-- FUNÇÕES: Triggers para atualização automática
-- =====================================================

-- Função para atualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER update_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_settings_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- DADOS INICIAIS
-- =====================================================

-- Configurações padrão
INSERT INTO system_settings (key, value, description) VALUES
('business_hours_start', '08:00', 'Horário de início do atendimento'),
('business_hours_end', '22:00', 'Horário de término do atendimento'),
('pix_discount_percentage', '5', 'Desconto percentual para pagamento via PIX'),
('ai_tone', 'friendly', 'Tom de voz da IA (friendly, professional, casual)')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- COMENTÁRIOS
-- =====================================================

COMMENT ON TABLE conversations IS 'Conversas com clientes via WhatsApp';
COMMENT ON TABLE messages IS 'Mensagens trocadas nas conversas';
COMMENT ON TABLE orders IS 'Pedidos de passagens rodoviárias';
COMMENT ON TABLE analytics_events IS 'Eventos para análise e métricas';
COMMENT ON TABLE system_settings IS 'Configurações do sistema';
