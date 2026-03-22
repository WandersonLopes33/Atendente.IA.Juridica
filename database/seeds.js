/**
 * Database Seeder
 * Popula banco com dados de exemplo para testes
 * Execute via: node database/seeds.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Dados de exemplo
const seedData = {
  viagens: [
    {
      origem: 'São Paulo',
      destino: 'Rio de Janeiro',
      data: '2025-02-20',
      hora_saida: '08:00',
      preco_convencional: 150.00,
      preco_executivo: 170.00,
      assentos_disponiveis: 45
    },
    {
      origem: 'São Paulo',
      destino: 'Rio de Janeiro',
      data: '2025-02-20',
      hora_saida: '13:00',
      preco_convencional: 150.00,
      preco_executivo: 170.00,
      assentos_disponiveis: 45
    },
    {
      origem: 'São Paulo',
      destino: 'Rio de Janeiro',
      data: '2025-02-20',
      hora_saida: '21:00',
      preco_convencional: 150.00,
      preco_executivo: 170.00,
      assentos_disponiveis: 45
    },
    {
      origem: 'São Paulo',
      destino: 'Belo Horizonte',
      data: '2025-02-21',
      hora_saida: '06:00',
      preco_convencional: 120.00,
      preco_executivo: 140.00,
      assentos_disponiveis: 45
    },
    {
      origem: 'Rio de Janeiro',
      destino: 'São Paulo',
      data: '2025-02-21',
      hora_saida: '10:00',
      preco_convencional: 150.00,
      preco_executivo: 170.00,
      assentos_disponiveis: 45
    },
    {
      origem: 'São Paulo',
      destino: 'Curitiba',
      data: '2025-02-22',
      hora_saida: '07:00',
      preco_convencional: 90.00,
      preco_executivo: 110.00,
      assentos_disponiveis: 45
    },
    {
      origem: 'São Paulo',
      destino: 'Brasília',
      data: '2025-02-23',
      hora_saida: '19:00',
      preco_convencional: 180.00,
      preco_executivo: 200.00,
      preco_leito: 230.00,
      assentos_disponiveis: 40
    },
    {
      origem: 'Rio de Janeiro',
      destino: 'Salvador',
      data: '2025-02-24',
      hora_saida: '20:00',
      preco_convencional: 280.00,
      preco_executivo: 310.00,
      preco_leito: 350.00,
      assentos_disponiveis: 35
    },
    {
      origem: 'São Paulo',
      destino: 'Florianópolis',
      data: '2025-02-25',
      hora_saida: '22:00',
      preco_convencional: 160.00,
      preco_executivo: 180.00,
      preco_leito: 210.00,
      assentos_disponiveis: 40
    }
  ]
};

async function seedDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🌱 Iniciando seed do banco de dados...\n');
    
    await client.query('BEGIN');
    
    // Seed Viagens
    console.log('📍 Inserindo viagens...');
    let viagensInseridas = 0;
    
    for (const viagem of seedData.viagens) {
      const query = `
        INSERT INTO viagens (
          origem, destino, data, hora_saida, 
          preco_convencional, preco_executivo, preco_leito,
          assentos_disponiveis, assentos_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
        RETURNING id;
      `;
      
      const values = [
        viagem.origem,
        viagem.destino,
        viagem.data,
        viagem.hora_saida,
        viagem.preco_convencional,
        viagem.preco_executivo,
        viagem.preco_leito || null,
        viagem.assentos_disponiveis,
        viagem.assentos_disponiveis
      ];
      
      const result = await client.query(query, values);
      if (result.rows.length > 0) {
        viagensInseridas++;
        console.log(`   ✓ ${viagem.origem} → ${viagem.destino} (${viagem.data} ${viagem.hora_saida})`);
      }
    }
    
    console.log(`\n✅ ${viagensInseridas} viagens inseridas\n`);
    
    // Seed Analytics (últimos 7 dias)
    console.log('📊 Gerando analytics de exemplo...');
    
    for (let i = 7; i >= 0; i--) {
      const data = new Date();
      data.setDate(data.getDate() - i);
      const dataFormatada = data.toISOString().split('T')[0];
      
      const conversasIniciadas = Math.floor(Math.random() * 50) + 20;
      const conversasConcluidas = Math.floor(conversasIniciadas * 0.7);
      const vendasRealizadas = Math.floor(conversasConcluidas * 0.4);
      const receitaTotal = vendasRealizadas * (Math.random() * 100 + 100);
      
      const query = `
        INSERT INTO analytics (
          data, conversas_iniciadas, conversas_concluidas,
          mensagens_enviadas, mensagens_recebidas,
          vendas_realizadas, receita_total,
          taxa_conversao, ticket_medio
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (data) DO NOTHING;
      `;
      
      const values = [
        dataFormatada,
        conversasIniciadas,
        conversasConcluidas,
        conversasIniciadas * 5,
        conversasIniciadas * 4,
        vendasRealizadas,
        receitaTotal.toFixed(2),
        ((vendasRealizadas / conversasIniciadas) * 100).toFixed(2),
        (receitaTotal / vendasRealizadas).toFixed(2)
      ];
      
      await client.query(query, values);
      console.log(`   ✓ ${dataFormatada}: ${conversasIniciadas} conversas, ${vendasRealizadas} vendas`);
    }
    
    console.log('\n✅ Analytics geradas\n');
    
    // Criar operador admin padrão
    console.log('👤 Criando operador admin...');
    
    const bcrypt = require('bcryptjs');
    const senhaHash = await bcrypt.hash('admin123', 10);
    
    const adminQuery = `
      INSERT INTO operators (nome, email, senha_hash, role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO NOTHING
      RETURNING id;
    `;
    
    const adminResult = await client.query(adminQuery, [
      'Administrador',
      'admin@viagemexpress.com.br',
      senhaHash,
      'admin'
    ]);
    
    if (adminResult.rows.length > 0) {
      console.log('   ✓ Admin criado: admin@viagemexpress.com.br / admin123');
      console.log('   ⚠️  ALTERE A SENHA EM PRODUÇÃO!\n');
    }
    
    await client.query('COMMIT');
    
    console.log('✨ Seed concluído com sucesso!\n');
    
    // Estatísticas finais
    const stats = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM viagens) as total_viagens,
        (SELECT COUNT(*) FROM analytics) as total_analytics,
        (SELECT COUNT(*) FROM operators) as total_operators,
        (SELECT COUNT(*) FROM settings) as total_settings;
    `);
    
    console.log('📊 Resumo do banco de dados:');
    console.log(`   • Viagens: ${stats.rows[0].total_viagens}`);
    console.log(`   • Analytics: ${stats.rows[0].total_analytics} dias`);
    console.log(`   • Operadores: ${stats.rows[0].total_operators}`);
    console.log(`   • Configurações: ${stats.rows[0].total_settings}\n`);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Erro durante seed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  seedDatabase()
    .then(() => {
      console.log('✅ Seed concluído!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Falha no seed:', error);
      process.exit(1);
    });
}

module.exports = { seedDatabase };
