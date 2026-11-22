const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { PublishCommand } = require('@aws-sdk/client-sns');
const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { sqsClient, snsClient, docClient } = require('../config/aws');
const { getPool } = require('../config/dbInit');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function updateOrderState(orderId, status, stepMessage) {
  const pool = getPool();
  const timestamp = new Date().toISOString();

  // 1. Update high-velocity real-time state in DynamoDB
  if (process.env.DYNAMODB_TABLE_NAME) {
    await docClient.send(new UpdateCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Key: { orderId },
      UpdateExpression: 'SET currentStatus = :s, updatedAt = :u, statusHistory = list_append(if_not_exists(statusHistory, :empty_list), :new_entry)',
      ExpressionAttributeValues: {
        ':s': status,
        ':u': timestamp,
        ':empty_list': [],
        ':new_entry': [{ status, message: stepMessage, timestamp }]
      }
    }));
  }

  // 2. Sync status to RDS MySQL master table
  await pool.query('UPDATE orders SET status = ? WHERE order_id = ?', [status, orderId]);
  console.log(`[WORKER] Order ${orderId} transitioned to -> ${status}`);
}

async function processOrderMessage(message) {
  const body = JSON.parse(message.Body);
  const { orderId, customerName, customerEmail, totalAmount, items } = body;
  const pool = getPool();

  console.log(`[WORKER] Picked up SQS job for Order ${orderId}`);

  // Stage 1: Verify & Deduct Inventory in RDS
  await sleep(3000);
  for (const item of items) {
    await pool.query('UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?', [item.quantity, item.id]);
  }
  await updateOrderState(orderId, 'INVENTORY_VERIFIED', 'Stock reserved and verified across fulfillment centers.');

  // Stage 2: Payment & Fraud Check Simulation
  await sleep(3500);
  await updateOrderState(orderId, 'PAYMENT_PROCESSED', `Payment of $${Number(totalAmount).toFixed(2)} authorized and captured.`);

  // Stage 3: Shipped & Dispatched
  await sleep(3500);
  await updateOrderState(orderId, 'SHIPPED', 'Package handed over to express courier with tracking generated.');

  // Stage 4: Trigger SNS Email/SMS Alert
  if (process.env.SNS_TOPIC_ARN) {
    const snsMessage = `Hello ${customerName},\n\nGreat news! Your CloudCart Order (${orderId}) totaling $${Number(totalAmount).toFixed(2)} has been verified, processed, and SHIPPED!\n\nCustomer Email: ${customerEmail}\nItems Count: ${items.length}\nStatus: SHIPPED\n\nThank you for shopping with CloudCart!`;
    await snsClient.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: `CloudCart Order Dispatched [${orderId}]`,
      Message: snsMessage
    }));
    console.log(`[SNS] Notification dispatched for Order ${orderId}`);
  }
}

async function startOrderWorker() {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    console.warn('[WORKER] SQS_QUEUE_URL not configured. Background worker disabled.');
    return;
  }

  console.log('[WORKER] Starting SQS Background Order Fulfillment Worker...');

  const poll = async () => {
    try {
      const response = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 45
      }));

      if (response.Messages && response.Messages.length > 0) {
        for (const msg of response.Messages) {
          try {
            await processOrderMessage(msg);
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle
            }));
          } catch (procErr) {
            console.error('[WORKER] Error processing message:', procErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[WORKER] SQS Polling Error:', err.message);
      await sleep(5000);
    }
    setImmediate(poll);
  };

  poll();
}

module.exports = { startOrderWorker };