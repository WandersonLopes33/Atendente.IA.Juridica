/**
 * Database Migration Script
 * Cria todas as tabelas necessarias no PostgreSQL
 * Execute via: node database/migrate.js
 */

const { Pool } = require('pg');
require('dotenv').config();

// Configuracao do pool de conexoes
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'viagemexpress',
  user: process.env.DB_USER || 'viagemexpress_user',
  password: String(process.env.DB_PASSWORD || ''),
  min: parseInt(process.env.DB_POOL_MIN || '2'),
  max: parseInt(process.env.DB_POOL_MAX || '20')
};

console.log('Configuracao do banco:');
console.log(`   Host: ${poolConfig.host}`);
console.log(`   Database: ${poolConfig.database}`);
console.log(`   User: ${poolConfig.user}`);
console.log(`   Password definida: ${poolConfig.password ? 'Sim' : 'NAO - ERRO!'}`);
console.log('');

const pool = new Pool(poolConfig);

const migrations = [
  {
    name: 'Create clientes table',
    sql: `
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        nome VARCHAR(255),
        cpf VARCHAR(14) UNIQUE,
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes(telefone);
      CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes(cpf);
    `
  },
  {
    name: 'Create conversations table',
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER REFERENCES clientes(id),
        telefone VARCHAR(20) NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        ultimo_estado VARCHAR(100),
        transferido_para_humano BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_conversations_telefone ON conversations(telefone);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
      CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
    `
  },
  {
    name: 'Create messages table',
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL,
        conteudo TEXT NOT NULL,
        sender VARCHAR(50) NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `
  },
  {
    name: 'Create viagens table',
    sql: `
      CREATE TABLE IF NOT EXISTS viagens (
        id SERIAL PRIMARY KEY,
        origem VARCHAR(100) NOT NULL,
        destino VARCHAR(100) NOT NULL,
        data DATE NOT NULL,
        hora_saida TIME NOT NULL,
        preco_convencional DECIMAL(10,2) NOT NULL,
        preco_executivo DECIMAL(10,2),
        preco_leito DECIMAL(10,2),
        assentos_disponiveis INTEGER NOT NULL DEFAULT 45,
        assentos_total INTEGER NOT NULL DEFAULT 45,
        tipo_onibus VARCHAR(50) DEFAULT 'convencional',
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_viagens_rota ON viagens(origem, destino);
      CREATE INDEX IF NOT EXISTS idx_viagens_data ON viagens(data);
      CREATE INDEX IF NOT EXISTS idx_viagens_ativo ON viagens(ativo);
    `
  },
  {
    name: 'Create orders table',
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        numero_pedido VARCHAR(50) UNIQUE NOT NULL,
        conversation_id INTEGER REFERENCES conversations(id),
        cliente_id INTEGER REFERENCES clientes(id),
        viagem_id INTEGER REFERENCES viagens(id),
        tipo_servico VARCHAR(50) NOT NULL,
        quantidade_passageiros INTEGER DEFAULT 1,
        assento VARCHAR(10),
        valor_total DECIMAL(10,2) NOT NULL,
        desconto DECIMAL(10,2) DEFAULT 0,
        valor_final DECIMAL(10,2) NOT NULL,
        metodo_pagamento VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pendente',
        data_viagem DATE NOT NULL,
        observacoes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_orders_numero ON orders(numero_pedido);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_cliente ON orders(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    `
  },
  {
    name: 'Create pagamentos table',
    sql: `
      CREATE TABLE IF NOT EXISTS pagamentos (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        valor DECIMAL(10,2) NOT NULL,
        metodo VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'pendente',
        transaction_id VARCHAR(255),
        comprovante_url TEXT,
        data_pagamento TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_pagamentos_order ON pagamentos(order_id);
      CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos(status);
      CREATE INDEX IF NOT EXISTS idx_pagamentos_transaction ON pagamentos(transaction_id);
    `
  },
  {
    name: 'Create analytics table',
    sql: `
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL UNIQUE,
        conversas_iniciadas INTEGER DEFAULT 0,
        conversas_concluidas INTEGER DEFAULT 0,
        conversas_transferidas INTEGER DEFAULT 0,
        mensagens_enviadas INTEGER DEFAULT 0,
        mensagens_recebidas INTEGER DEFAULT 0,
        vendas_realizadas INTEGER DEFAULT 0,
        vendas_canceladas INTEGER DEFAULT 0,
        receita_total DECIMAL(10,2) DEFAULT 0,
        receita_liquida DECIMAL(10,2) DEFAULT 0,
        tempo_medio_resposta INTEGER DEFAULT 0,
        taxa_conversao DECIMAL(5,2) DEFAULT 0,
        ticket_medio DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_analytics_data ON analytics(data);
    `
  },
  {
    name: 'Create operators table',
    sql: `
      CREATE TABLE IF NOT EXISTS operators (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'operator',
        ativo BOOLEAN DEFAULT true,
        ultimo_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_operators_email ON operators(email);
      CREATE INDEX IF NOT EXISTS idx_operators_ativo ON operators(ativo);
    `
  },
  {
    name: 'Create settings table',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'string',
        description TEXT,
        categoria VARCHAR(50) DEFAULT 'geral',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);
      CREATE INDEX IF NOT EXISTS idx_settings_categoria ON settings(categoria);
    `
  },
  {
    name: 'Insert default settings',
    sql: `
      INSERT INTO settings (key, value, type, description, categoria) VALUES
      ('ai_provider', 'groq', 'string', 'Provider de IA atual', 'ai'),
      ('ai_model', 'llama-3.3-70b-versatile', 'string', 'Modelo de IA', 'ai'),
      ('ai_temperature', '0.7', 'float', 'Temperatura da IA', 'ai'),
      ('ai_tone', 'friendly', 'string', 'Tom do atendimento', 'ai'),
      ('business_hours_start', '08:00', 'time', 'Horario de abertura', 'operacao'),
      ('business_hours_end', '22:00', 'time', 'Horario de fechamento', 'operacao'),
      ('pix_discount_percentage', '5', 'integer', 'Desconto PIX (%)', 'vendas'),
      ('max_installments', '6', 'integer', 'Maximo de parcelas', 'vendas'),
      ('company_name', 'ViagemExpress', 'string', 'Nome da empresa', 'geral'),
      ('support_phone', '+5511999999999', 'string', 'Telefone de suporte', 'geral'),
      ('support_email', 'suporte@viagemexpress.com.br', 'string', 'Email de suporte', 'geral'),
      ('auto_transfer_enabled', 'true', 'boolean', 'Transferencia automatica para humano', 'operacao'),
      ('rate_limit_max', '10', 'integer', 'Maximo de mensagens por minuto', 'seguranca'),
      ('cache_enabled', 'true', 'boolean', 'Cache Redis habilitado', 'performance')
      ON CONFLICT (key) DO NOTHING;
    `
  },
  {
    name: 'Create trigger for updated_at',
    sql: `
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
      
      DROP TRIGGER IF EXISTS update_clientes_updated_at ON clientes;
      CREATE TRIGGER update_clientes_updated_at BEFORE UPDATE ON clientes
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
      CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_viagens_updated_at ON viagens;
      CREATE TRIGGER update_viagens_updated_at BEFORE UPDATE ON viagens
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
      CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      
      DROP TRIGGER IF EXISTS update_operators_updated_at ON operators;
      CREATE TRIGGER update_operators_updated_at BEFORE UPDATE ON operators
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `
  }
];

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    console.log('Iniciando migracoes do banco de dados...\n');
    
    await client.query('BEGIN');
    
    for (const migration of migrations) {
      try {
        console.log(`Executando: ${migration.name}...`);
        await client.query(migration.sql);
        console.log(`OK - ${migration.name}\n`);
      } catch (error) {
        console.error(`ERRO em ${migration.name}:`, error.message);
        throw error;
      }
    }
    
    await client.query('COMMIT');
    
    console.log('Todas as migracoes foram executadas com sucesso!\n');
    console.log('Tabelas criadas:');
    console.log('   * clientes');
    console.log('   * conversations');
    console.log('   * messages');
    console.log('   * viagens');
    console.log('   * orders');
    console.log('   * pagamentos');
    console.log('   * analytics');
    console.log('   * operators');
    console.log('   * settings\n');
    
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    
    console.log('Tabelas no banco de dados:');
    result.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\nERRO durante migracao:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('\nMigracao concluida com sucesso!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\nFalha na migracao:', error);
      process.exit(1);
    });
}

module.exports = { runMigrations };
