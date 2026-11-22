let products = [];
let cart = [];
let pollingInterval = null;

const productGrid = document.getElementById('product-grid');
const cartCount = document.getElementById('cart-count');
const cartDrawer = document.getElementById('cart-drawer');
const cartOverlay = document.getElementById('cart-overlay');
const cartItemsContainer = document.getElementById('cart-items');
const cartSubtotal = document.getElementById('cart-subtotal');
const checkoutModal = document.getElementById('checkout-modal');

// Fetch Catalog from RDS API
async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    products = await res.json();
    renderProducts();
  } catch (err) {
    productGrid.innerHTML = `<div class="loader">Error loading products from server.</div>`;
  }
}

function renderProducts() {
  productGrid.innerHTML = products.map(p => `
    <div class="product-card">
      <img src="${p.image_url}" alt="${p.name}" class="product-img" />
      <div class="product-body">
        <div class="product-meta">
          <span>${p.category}</span>
          <span class="stock-tag">${p.stock} in stock</span>
        </div>
        <h3 class="product-title">${p.name}</h3>
        <p class="product-desc">${p.description}</p>
        <div class="product-footer">
          <span class="product-price">$${Number(p.price).toFixed(2)}</span>
          <button class="btn btn-primary" onclick="addToCart(${p.id})">Add to Bag</button>
        </div>
      </div>
    </div>
  `).join('');
}

function addToCart(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  const existing = cart.find(item => item.id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ ...product, quantity: 1 });
  }
  updateCartUI();
  openCart();
}

function removeFromCart(productId) {
  cart = cart.filter(item => item.id !== productId);
  updateCartUI();
}

function updateCartUI() {
  const totalCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  cartCount.textContent = totalCount;

  if (cart.length === 0) {
    cartItemsContainer.innerHTML = `<p style="color:#94a3b8;">Your bag is currently empty.</p>`;
  } else {
    cartItemsContainer.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div>
          <strong>${item.name}</strong>
          <div style="font-size:0.85rem;color:#94a3b8;">Qty: ${item.quantity} × $${Number(item.price).toFixed(2)}</div>
        </div>
        <button class="close-btn" onclick="removeFromCart(${item.id})">&times;</button>
      </div>
    `).join('');
  }

  const total = cart.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
  cartSubtotal.textContent = `$${total.toFixed(2)}`;
}

function openCart() {
  cartDrawer.classList.add('open');
  cartOverlay.classList.remove('hidden');
}

function closeCart() {
  cartDrawer.classList.remove('open');
  cartOverlay.classList.add('hidden');
}

document.getElementById('open-cart-btn').addEventListener('click', openCart);
document.getElementById('close-cart-btn').addEventListener('click', closeCart);
cartOverlay.addEventListener('click', closeCart);

document.getElementById('proceed-checkout-btn').addEventListener('click', () => {
  if (cart.length === 0) return alert('Add items to your bag first!');
  closeCart();
  checkoutModal.classList.remove('hidden');
});

document.getElementById('close-modal-btn').addEventListener('click', () => {
  checkoutModal.classList.add('hidden');
});

// Submit Order
document.getElementById('checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customerName = document.getElementById('cust-name').value;
  const customerEmail = document.getElementById('cust-email').value;
  const btn = document.getElementById('submit-order-btn');

  btn.disabled = true;
  btn.textContent = 'Publishing to SQS & RDS...';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName, customerEmail, items: cart })
    });
    const data = await res.json();
    if (res.ok) {
      cart = [];
      updateCartUI();
      checkoutModal.classList.add('hidden');
      document.getElementById('track-input').value = data.orderId;
      document.getElementById('tracker-section').scrollIntoView({ behavior: 'smooth' });
      startLiveTracking(data.orderId);
      loadRecentOrders();
      loadProducts();
    } else {
      alert(data.error || 'Order failed');
    }
  } catch (err) {
    alert('Network error submitting order.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place Order Now';
  }
});

// Live Order Tracking Polling Engine
function startLiveTracking(orderId) {
  if (pollingInterval) clearInterval(pollingInterval);
  fetchTrackingStatus(orderId);
  pollingInterval = setInterval(() => fetchTrackingStatus(orderId), 2000);
}

async function fetchTrackingStatus(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}/track`);
    if (!res.ok) return;
    const { source, data } = await res.json();

    document.getElementById('tracker-display').classList.remove('hidden');
    document.getElementById('t-order-id').textContent = data.orderId;
    document.getElementById('t-customer').textContent = data.customerName;
    document.getElementById('t-total').textContent = Number(data.totalAmount).toFixed(2);
    document.getElementById('t-source').textContent = source;

    const stages = ['QUEUED', 'INVENTORY_VERIFIED', 'PAYMENT_PROCESSED', 'SHIPPED'];
    const currentIdx = stages.indexOf(data.currentStatus);

    document.querySelectorAll('.step').forEach((el, idx) => {
      if (idx <= currentIdx) el.classList.add('active');
      else el.classList.remove('active');
    });

    const history = data.statusHistory || [];
    document.getElementById('t-timeline').innerHTML = history.map(h => `
      <li>
        <span><strong>[${h.status}]</strong> ${h.message}</span>
        <span style="color:#94a3b8;">${new Date(h.timestamp).toLocaleTimeString()}</span>
      </li>
    `).join('');

    if (data.currentStatus === 'SHIPPED') {
      clearInterval(pollingInterval);
      loadProducts();
      loadRecentOrders();
    }
  } catch (err) {
    console.error('Tracking poll error:', err);
  }
}

document.getElementById('track-btn').addEventListener('click', () => {
  const val = document.getElementById('track-input').value.trim();
  if (val) startLiveTracking(val);
});

document.getElementById('refresh-catalog-btn').addEventListener('click', loadProducts);

async function loadRecentOrders() {
  try {
    const res = await fetch('/api/orders');
    const list = await res.json();
    const container = document.getElementById('recent-orders-list');
    container.innerHTML = list.map(o => `
      <span class="chip" onclick="document.getElementById('track-input').value='${o.order_id}'; startLiveTracking('${o.order_id}')">
        ${o.order_id} (${o.status})
      </span>
    `).join('');
  } catch (e) {}
}

// Initialize on page load
loadProducts();
loadRecentOrders();