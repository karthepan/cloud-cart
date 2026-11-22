# CloudCart — Event-Driven Microservices E-Commerce Order Processing System

[![AWS](https://img.shields.io/badge/AWS-Elastic%20Beanstalk%20%7C%20RDS%20%7C%20DynamoDB%20%7C%20SQS%20%7C%20SNS-FF9900?style=flat-square&logo=amazon-aws)](https://aws.amazon.com/)
[![Node.js](https://img.shields.io/badge/Node.js-Express%20%7C%20AWS%20SDK%20v3-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/Polyglot%20Persistence-MySQL%20%26%20DynamoDB-4479A1?style=flat-square)](https://aws.amazon.com/rds/)

**CloudCart** is an asynchronous, event-driven e-commerce order processing platform built on Amazon Web Services (AWS) using Node.js, Express, and AWS SDK v3[cite: 1]. It decouples high-concurrency customer checkout requests from latency-heavy backend fulfillment workflows (inventory verification, payment processing, and shipping notifications), preventing thread blocking and HTTP 504 timeouts during traffic surges.

---

## Table of Contents
- [Architecture Overview](#architecture-overview)
- [Key Features](#key-features)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Database Design (Polyglot Persistence)](#database-design-polyglot-persistence)
- [API Endpoints](#api-endpoints)
- [AWS Deployment Guide (Zero-Terminal Setup)](#aws-deployment-guide-zero-terminal-setup)
- [Monitoring & Observability](#monitoring--observability)

---

## Architecture Overview

CloudCart separates cloud resources into five distinct architectural tiers within `us-east-1`:

1. **Client Presentation Tier:** Responsive HTML5/CSS3/Vanilla JS storefront featuring a live cart drawer, express checkout modal, and a real-time order telemetry tracker that polls status updates every 2 seconds[cite: 2, 7, 8, 12].
2. **Compute & API Ingress Tier:** Hosted on **AWS Elastic Beanstalk** (Node.js 24 on Amazon Linux 2023) running both the Express REST API and an asynchronous background worker[cite: 2, 9].
3. **Messaging Tier:** **Amazon SQS** (`CloudCart-Order-Queue`) buffers incoming order events to isolate checkout responsiveness from downstream processing latency[cite: 1, 2].
4. **Polyglot Storage Tier:**
   - **Amazon RDS (MySQL):** ACID-compliant relational system of record for product catalog, inventory stock, master orders, and line items[cite: 2, 5, 6].
   - **Amazon DynamoDB (`CloudCart-Order-State`):** High-velocity NoSQL store tracking live order states and step-by-step audit history[cite: 2, 5].
5. **Notifications & Observability Tier:** **Amazon SNS** (`CloudCart-Order-Alerts`) dispatches automated order shipment alerts, while **Amazon CloudWatch** streams real-time stdout/stderr logs[cite: 2, 11].

### End-to-End Order Lifecycle
1. **Catalog Retrieval:** Storefront fetches live hardware products and stock counts from RDS MySQL (`GET /api/products`).
2. **Fast-Path Order Ingestion:** On checkout (`POST /api/orders`), the API writes the master order to RDS MySQL, initializes a `QUEUED` state log in DynamoDB, publishes the job payload to Amazon SQS, and immediately returns an Order ID to the user[cite: 1, 2].
3. **Asynchronous Fulfillment:** The background SQS long-polling worker (`orderWorker.js`) picks up the message and executes sequential fulfillment stages[cite: 2, 32, 34]:
   - `QUEUED` → `INVENTORY_VERIFIED` (Deducts stock in RDS MySQL)[cite: 32, 33]
   - `INVENTORY_VERIFIED` → `PAYMENT_PROCESSED` (Authorizes & captures payment)[cite: 33]
   - `PAYMENT_PROCESSED` → `SHIPPED` (Dispatches package & triggers SNS email/SMS notification)[cite: 33]
4. **Live Telemetry Sync:** At every stage, the worker appends timestamped logs to DynamoDB and syncs the status back to RDS[cite: 2, 31, 32].

---

## Key Features

- **Non-Blocking Express Checkout:** Instant HTTP responses powered by SQS queue decoupling[cite: 1, 2].
- **ACID-Compliant Inventory Management:** Relational foreign keys and atomic stock updates in RDS MySQL prevent overselling and race conditions[cite: 5, 6].
- **Real-Time Order Telemetry Tracker:** Interactive frontend stepper and audit log timeline polling DynamoDB every 2 seconds[cite: 2, 8, 15, 23].
- **Zero-Touch Database Bootstrapping:** `dbInit.js` automatically creates `cloudcart_db`, builds tables (`products`, `orders`, `order_items`), and seeds initial tech hardware inventory on startup—requiring zero manual SSH or SQL CLI commands[cite: 2, 9, 27, 29].
- **Automated Dispatch Alerts:** Integrated Amazon SNS notifications upon order shipment[cite: 2, 33].

---

## Technology Stack

| Layer | Technology / AWS Service | Purpose |
| :--- | :--- | :--- |
| **Frontend** | HTML5, CSS3, Vanilla JavaScript | Storefront UI, slide-over cart, checkout modal, live order polling[cite: 2, 7, 8, 12] |
| **Backend & Worker** | Node.js, Express.js, AWS SDK v3 | REST API ingress, SQS consumer worker, automated DB seeding[cite: 1, 2] |
| **Compute** | AWS Elastic Beanstalk (EC2 `t3.micro`) | Managed runtime environment & auto-scaling web tier[cite: 2, 10] |
| **Relational DB** | Amazon RDS (`db.t4g.micro`, MySQL) | Master product catalog, orders, line items, and stock levels[cite: 2, 7] |
| **NoSQL DB** | Amazon DynamoDB (On-Demand) | Low-latency order tracking and audit state history[cite: 2, 8] |
| **Queue & Pub/Sub** | Amazon SQS & Amazon SNS | Asynchronous job decoupling and email/SMS dispatch notifications |
| **Security & Logs** | AWS IAM, VPC Security Groups, CloudWatch | Role-based instance permissions, port isolation, and centralized logging[cite: 3, 9, 11] |

---

## Project Structure

```text
cloudcart/
├── .ebextensions/
│   └── 01_cloudwatch.config   # Configures automated stdout/stderr log streaming to CloudWatch
├── database/
│   └── schema.sql             # Reference SQL DDL for products, orders, and order_items
├── public/
│   ├── index.html             # Main storefront, cart drawer, checkout modal & order tracker UI
│   ├── style.css              # Responsive dark/modern UI styling
│   └── script.js              # Cart state management, REST API integration & 2s status polling
├── src/
│   ├── config/
│   │   ├── aws.js             # AWS SDK v3 client initialization (SQS, SNS, DynamoDB)
│   │   └── dbInit.js          # Auto-creates RDS database, tables, and seeds initial products
│   ├── workers/
│   │   └── orderWorker.js     # Long-polling SQS worker executing fulfillment stages & SNS alerts
│   └── server.js              # Express REST API server & worker bootstrapper
├── .env.example               # Template for required environment variables
├── package.json               # Node.js dependencies and start scripts
└── Procfile                   # Elastic Beanstalk process execution definition

## Database Design (Polyglot Persistence)

### 1. Amazon RDS MySQL (`cloudcart_db`)[cite: 5]
* **`products`**: `id` (PK), `name`, `category`, `price`, `stock`, `image_url`, `description`[cite: 5]
* **`orders`**: `order_id` (PK), `customer_name`, `customer_email`, `total_amount`, `status`, `created_at`[cite: 5]
* **`order_items`**: `id` (PK), `order_id` (FK → `orders`), `product_id` (FK → `products`), `quantity`, `price`[cite: 5]

### 2. Amazon DynamoDB (`CloudCart-Order-State`)[cite: 5]
* **Partition Key:** `orderId` (String)[cite: 5]
* **Attributes:** `customerName`, `customerEmail`, `totalAmount`, `currentStatus`, `createdAt`, `updatedAt`, `statusHistory` (List of timestamped state transition maps)[cite: 5]

---

## API Endpoints

| Method | Endpoint | Description | Data Store |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/products` | Fetches available product catalog and live stock counts[cite: 2, 18] | RDS MySQL[cite: 2] |
| `GET` | `/api/orders` | Retrieves recent orders for quick status tracking chips[cite: 25] | RDS MySQL[cite: 2] |
| `POST` | `/api/orders` | Creates an order, logs initial state, and queues SQS job[cite: 1, 2, 22] | RDS MySQL + DynamoDB + SQS[cite: 1, 2] |
| `GET` | `/api/orders/:id/track` | Polls real-time fulfillment progress and transition history[cite: 2, 23] | DynamoDB[cite: 2, 14] |

---

## AWS Deployment Guide (Zero-Terminal Setup)

CloudCart is engineered for 100% AWS Management Console deployment—no `.pem` key pairs or SSH commands are required.

### 1. IAM Roles Setup
Create an EC2 instance role (`CloudCart-EC2-Role`) with permissions for[cite: 9]:
* `AWSElasticBeanstalkWebTier`[cite: 9]
* Amazon SQS, Amazon SNS, Amazon DynamoDB, and CloudWatch Logs[cite: 9]

### 2. Database & Storage Setup
1. **DynamoDB:** Create an on-demand table named `CloudCart-Order-State` with Partition Key `orderId` (`String`)[cite: 8, 9].
2. **RDS MySQL:** Launch a MySQL instance (`cloudcart-db`, e.g., `db.t4g.micro`)[cite: 7, 9] and configure its VPC Security Group (`CloudCart-RDS-SG`) to allow inbound TCP traffic on port `3306` from your Elastic Beanstalk security group[cite: 3, 9].

### 3. Messaging & Notification Setup
1. **SQS:** Create a Standard Queue named `CloudCart-Order-Queue`[cite: 9, 10] and copy its Queue URL.
2. **SNS:** Create a Standard Topic named `CloudCart-Order-Alerts`, add an Email subscription, and confirm the subscription via email[cite: 9, 11].

### 4. Elastic Beanstalk Deployment
1. Zip the project root contents into `cloudcart-deploy.zip` (**exclude** `node_modules`)[cite: 9].
2. Create a new **Node.js** Elastic Beanstalk environment (`CloudCart-Env`) and attach `CloudCart-EC2-Role`[cite: 9, 10].
3. Configure the following **Environment Properties** in Elastic Beanstalk[cite: 9]:
   ```env
   AWS_REGION=us-east-1
   DB_HOST=<your-rds-instance-endpoint>
   DB_PORT=3306
   DB_USER=admin
   DB_PASSWORD=<your-rds-password>
   DB_NAME=cloudcart_db
   DYNAMODB_TABLE_NAME=CloudCart-Order-State
   SQS_QUEUE_URL=<your-sqs-queue-url>
   SNS_TOPIC_ARN=<your-sns-topic-arn>

Upload cloudcart-deploy.zip and deploy[cite: 9]. Upon startup, dbInit.js will automatically initialize the database schema and seed the storefront catalog.

## Monitoring & Observability
Application logs are automatically routed to Amazon CloudWatch Logs under /aws/elasticbeanstalk/CloudCart-Env/var/log/web.stdout.log via .ebextensions/01_cloudwatch.config. You can monitor database seeding ([DB-INIT]), order ingestion ([ORDER CREATED]), background worker transitions ([WORKER]), and alert dispatches ([SNS]) in real time directly from the CloudWatch console.
