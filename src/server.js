require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const { sqsClient, docClient } = require('./config/aws');
const { initializeDatabase, getPool } = require('./config/dbInit');
const { startOrderWorker } = require('./workers/orderWorker');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint for Elastic Beanstalk Load Balancer
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'HEALTHY', service: 'CloudCart-API', timestamp: new Date().toISOString() });
});

// GET all products from RDS MySQL
app.get('/api/products', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM products ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    console.error('[API ERROR] /api/products:', err.message);
    res.status(500).json({ error: 'Failed to fetch products from RDS' });
  }
});

// POST new order -> Write to RDS + Write Initial State to DynamoDB + Enqueue to SQS
app.post('/api/orders', async (req, res) => {
  const { customerName, customerEmail, items } = req.body;
  if (!customerName || !customerEmail || !items || !items.length) {
    return res.status(400).json({ error: 'Invalid order payload' });
  }

  const orderId = `CC-${uuidv4().substring(0, 8).toUpperCase()}`;
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    let totalAmount = 0;
    for (const item of items) {
      totalAmount += Number(item.price) * Number(item.quantity);
    }

    // 1. Insert Master Order into RDS
    await connection.query(
      'INSERT INTO orders (order_id, customer_name, customer_email, total_amount, status) VALUES (?, ?, ?, ?, ?)',
      [orderId, customerName, customerEmail, totalAmount, 'QUEUED']
    );

    // 2. Insert Order Line Items into RDS
    for (const item of items) {
      await connection.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
        [orderId, item.id, item.quantity, item.price]
      );
    }

    await connection.commit();
    console.log(`[ORDER CREATED] ${orderId} saved to RDS MySQL ($${totalAmount.toFixed(2)})`);

    const now = new Date().toISOString();

    // 3. Log High-Velocity Real-Time State in DynamoDB
    if (process.env.DYNAMODB_TABLE_NAME) {
      await docClient.send(new PutCommand({
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: {
          orderId,
          customerName,
          customerEmail,
          totalAmount,
          currentStatus: 'QUEUED',
          createdAt: now,
          updatedAt: now,
          statusHistory: [
            {
              status: 'QUEUED',
              message: 'Order received and published to AWS SQS queue for asynchronous fulfillment.',
              timestamp: now
            }
          ]
        }
      }));
      console.log(`[DYNAMODB] Initial state logged for ${orderId}`);
    }

    // 4. Push Order Payload to AWS SQS Queue
    if (process.env.SQS_QUEUE_URL) {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ orderId, customerName, customerEmail, totalAmount, items })
      }));
      console.log(`[SQS] Enqueued order ${orderId} for background worker`);
    }

    res.status(201).json({
      message: 'Order placed successfully!',
      orderId,
      status: 'QUEUED',
      totalAmount
    });
  } catch (err) {
    await connection.rollback();
    console.error('[API ERROR] /api/orders:', err.message);
    res.status(500).json({ error: 'Failed to place order', details: err.message });
  } finally {
    connection.release();
  }
});

// GET Live Order Tracking State (Reads from DynamoDB first, falls back to RDS)
app.get('/api/orders/:orderId/track', async (req, res) => {
  const { orderId } = req.params;
  try {
    if (process.env.DYNAMODB_TABLE_NAME) {
      const ddbRes = await docClient.send(new GetCommand({
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Key: { orderId }
      }));
      if (ddbRes.Item) {
        return res.json({ source: 'Amazon DynamoDB (Real-Time State)', data: ddbRes.Item });
      }
    }

    // Fallback to RDS
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM orders WHERE order_id = ?', [orderId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({
      source: 'Amazon RDS MySQL',
      data: {
        orderId: rows[0].order_id,
        customerName: rows[0].customer_name,
        totalAmount: rows[0].total_amount,
        currentStatus: rows[0].status,
        updatedAt: rows[0].created_at,
        statusHistory: [{ status: rows[0].status, message: 'Status retrieved from RDS.', timestamp: rows[0].created_at }]
      }
    });
  } catch (err) {
    console.error('[API ERROR] Track order:', err.message);
    res.status(500).json({ error: 'Failed to retrieve tracking state' });
  }
});

// GET recent orders list
app.get('/api/orders', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Bootstrapping Server
async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`====================================================`);
      console.log(`🚀 CloudCart Server running on port ${PORT}`);
      console.log(`====================================================`);
      startOrderWorker();
    });
  } catch (err) {
    console.error('CRITICAL: Server failed to start due to database initialization failure.', err);
    process.exit(1);
  }
}

startServer();