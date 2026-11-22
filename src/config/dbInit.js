const mysql = require('mysql2/promise');

let pool;

async function initializeDatabase() {
  try {
    console.log('[DB-INIT] Connecting to RDS MySQL host to verify database...');
    // Step 1: Connect without specifying database to create it if missing
    const initialConnection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    const dbName = process.env.DB_NAME || 'cloudcart_db';
    await initialConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
    await initialConnection.end();
    console.log(`[DB-INIT] Database '${dbName}' verified.`);

    // Step 2: Create connection pool connected to the database
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Step 3: Create Tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        stock INT NOT NULL DEFAULT 50,
        image_url VARCHAR(500) NOT NULL,
        description TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id VARCHAR(64) PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'QUEUED',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id VARCHAR(64) NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id)
      );
    `);

    // Step 4: Seed initial trendy products if table is empty
    const [rows] = await pool.query('SELECT COUNT(*) AS count FROM products');
    if (rows[0].count === 0) {
      console.log('[DB-INIT] Seeding initial product catalog...');
      const seedProducts = [
        ['Aether Pro Wireless Headphones', 'Audio', 299.99, 45, 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=80', 'Studio-grade spatial audio with adaptive active noise cancellation.'],
        ['Chronos Minimalist Smart Watch', 'Wearables', 199.50, 30, 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=600&q=80', 'Sapphire crystal display with 14-day battery and biometric tracking.'],
        ['Lumina Mechanical Keycap Set', 'Accessories', 129.00, 60, 'https://images.unsplash.com/photo-1595225476474-87563907a212?auto=format&fit=crop&w=600&q=80', 'Custom anodized aluminum frame with hot-swappable tactile switches.'],
        ['Vortex Ultra-Light Gaming Mouse', 'Peripherals', 89.99, 80, 'https://images.unsplash.com/photo-1527814050087-3793815479db?auto=format&fit=crop&w=600&q=80', 'Sub-50g magnesium alloy exoskeleton with 26K DPI optical sensor.'],
        ['Nova 4K USB-C Studio Webcam', 'Video', 159.00, 25, 'https://images.unsplash.com/photo-1587826080692-f439cd0b70da?auto=format&fit=crop&w=600&q=80', 'Sony STARVIS CMOS sensor with AI auto-framing and dual mics.'],
        ['Zenith Ergonomic Desk Mat', 'Workspace', 49.00, 100, 'https://images.unsplash.com/photo-1616400619175-5beda3a17896?auto=format&fit=crop&w=600&q=80', 'Merino wool felt and vegan leather desk pad for modern setups.']
      ];
      await pool.query(
        'INSERT INTO products (name, category, price, stock, image_url, description) VALUES ?',
        [seedProducts]
      );
      console.log('[DB-INIT] Product catalog seeded successfully.');
    }

    return pool;
  } catch (error) {
    console.error('[DB-INIT ERROR] Failed to initialize RDS database:', error.message);
    throw error;
  }
}

function getPool() {
  if (!pool) {
    throw new Error('Database pool has not been initialized yet.');
  }
  return pool;
}

module.exports = { initializeDatabase, getPool };