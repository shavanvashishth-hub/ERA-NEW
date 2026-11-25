"""
ERA Autonomous Application Code Synthesizer
Generates production-grade, interactive, and responsive web applications, SaaS dashboards,
e-commerce stores, portfolios, and Kanban boards from natural language objectives.
"""

import html
import os
import re
from pathlib import Path

def _synthesize_with_ai(objective: str, filename: str) -> str:
    """Attempts to synthesize customized production code using Gemini AI models."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        env_candidates = [
            Path(r"d:\era_agent\.env"),
            Path(r"d:\era-voice-assistant\.env")
        ]
        for ec in env_candidates:
            if ec.exists():
                try:
                    from dotenv import load_dotenv
                    load_dotenv(ec)
                    api_key = os.getenv("GEMINI_API_KEY")
                    if api_key:
                        break
                except Exception:
                    pass

    if not api_key:
        return ""

    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        candidate_models = ["models/gemini-3-flash-preview", "models/gemini-3.1-flash-lite", "models/gemini-2.5-flash"]
        prompt = f"""You are ERA's Autonomous Senior Principal Systems Architect.
Generate COMPLETE, PRODUCTION-READY, FLAWLESS code for file '{filename}' based on user objective:
"{objective}"

RULES:
1. Provide ONLY the complete source code for '{filename}'. Do not include conversational markdown text or placeholders.
2. Full working production logic with state, event handling, error boundaries, and modern design.
3. If this is HTML, include Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>) and FontAwesome.
4. Output the raw code inside a markdown code block:
```{filename.split('.')[-1] if '.' in filename else ''}
<code>
```
"""
        for m in candidate_models:
            try:
                model = genai.GenerativeModel(m)
                res = model.generate_content(prompt)
                raw = res.text or ""
                if raw.strip():
                    match = re.search(r"```[a-zA-Z0-9_\-\.]*\s*(?:\r?\n)([\s\S]*?)```", raw)
                    code = match.group(1).strip() if match else raw.strip()
                    if len(code) > 50:
                        return code
            except Exception:
                continue
    except Exception:
        pass
    return ""


def synthesize_code(objective: str, filename: str) -> str:
    obj = objective.strip() if objective else "Autonomous Web Application"
    obj_clean = html.escape(obj)
    obj_lower = obj.lower()

    # 1. Try AI-driven customized synthesis first
    ai_code = _synthesize_with_ai(obj, filename)
    if ai_code:
        return ai_code

    # 2. Deterministic high-quality fallback generator
    # Determine archetype
    is_ecom = any(k in obj_lower for k in ["ecommerce", "e-commerce", "shop", "store", "cart", "product", "cloth", "shoe", "market", "buy", "watch"])
    is_saas = any(k in obj_lower for k in ["saas", "dashboard", "analytics", "crypto", "finance", "kpi", "metric", "admin", "crm", "stock"])
    is_portfolio = any(k in obj_lower for k in ["portfolio", "resume", "cv", "developer", "personal", "profile", "bio"])
    is_kanban = any(k in obj_lower for k in ["kanban", "todo", "task", "project management", "board", "planner", "trello", "jira"])
    is_game = any(k in obj_lower for k in ["game", "snake", "runner", "arcade", "play", "temple run", "pong", "tetris", "flappy"])

    ext = filename.split(".")[-1].lower() if "." in filename else ""

    if ext == "py":
        return _generate_python_launcher(obj_clean)

    if is_ecom:
        if ext == "html":
            return _generate_ecom_html(obj_clean)
        elif ext == "css":
            return _generate_ecom_css()
        elif ext == "js":
            return _generate_ecom_js(obj_clean)

    elif is_saas:
        if ext == "html":
            return _generate_saas_html(obj_clean)
        elif ext == "css":
            return _generate_saas_css()
        elif ext == "js":
            return _generate_saas_js(obj_clean)

    elif is_portfolio:
        if ext == "html":
            return _generate_portfolio_html(obj_clean)
        elif ext == "css":
            return _generate_portfolio_css()
        elif ext == "js":
            return _generate_portfolio_js(obj_clean)

    elif is_kanban:
        if ext == "html":
            return _generate_kanban_html(obj_clean)
        elif ext == "css":
            return _generate_kanban_css()
        elif ext == "js":
            return _generate_kanban_js(obj_clean)

    elif is_game:
        if ext == "html":
            return _generate_game_html(obj_clean)
        elif ext == "css":
            return _generate_game_css()
        elif ext == "js":
            return _generate_game_js(obj_clean)

    # Generic Custom Application matching user's specific prompt
    if ext == "html":
        return _generate_custom_html(obj_clean)
    elif ext == "css":
        return _generate_custom_css()
    elif ext == "js":
        return _generate_custom_js(obj_clean)

    return f"// Deliverable {filename} for: {obj_clean}\n// Generated autonomously by ERA Autonomous Engine\n"


def _generate_python_launcher(title: str) -> str:
    template = '''import http.server
import socketserver
import webbrowser
import threading
import time
import os
import sys

PORT = 8080

def start_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    Handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print("🚀 ERA Application Server [{APP_TITLE}] active on http://127.0.0.1:" + str(PORT))
        httpd.serve_forever()

if __name__ == '__main__':
    t = threading.Thread(target=start_server, daemon=True)
    t.start()
    time.sleep(1.0)
    url = "http://127.0.0.1:" + str(PORT)
    print("✨ Opening live application in default browser: " + url)
    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\\nApplication server stopped.")
        sys.exit(0)
'''
    return template.replace("{APP_TITLE}", title)

# ─────────────────────────────────────────────────────────────────────────────
# E-COMMERCE
# ─────────────────────────────────────────────────────────────────────────────
def _generate_ecom_html(title: str) -> str:
    template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{APP_TITLE} — Autonomous E-Commerce Store</title>
  <link rel="stylesheet" href="styles.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
  <!-- Header / Navigation -->
  <header class="navbar">
    <div class="nav-container">
      <div class="logo">
        <span class="logo-icon">🛍️</span>
        <span class="logo-text">{APP_TITLE}</span>
      </div>
      <div class="search-bar">
        <input type="text" id="searchInput" placeholder="Search products, brands, or collections...">
      </div>
      <div class="nav-actions">
        <button id="cartBtn" class="cart-btn">
          🛒 Cart (<span id="cartCount">0</span>)
        </button>
      </div>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="hero-banner">
    <div class="hero-content">
      <span class="badge">🔥 Verified Production Store</span>
      <h1>Autonomous Shopping Experience</h1>
      <p>Precision-built catalog powered by ERA Autonomous Outcome Engine.</p>
    </div>
  </section>

  <!-- Filter & Categories -->
  <div class="container main-content">
    <aside class="sidebar">
      <h3>Filter Products</h3>
      <div class="filter-group">
        <label>Category</label>
        <select id="categoryFilter">
          <option value="all">All Categories</option>
          <option value="electronics">Electronics & Audio</option>
          <option value="apparel">Designer Apparel</option>
          <option value="accessories">Smart Accessories</option>
        </select>
      </div>
      <div class="filter-group">
        <label>Sort By</label>
        <select id="sortFilter">
          <option value="featured">Featured First</option>
          <option value="price-low">Price: Low to High</option>
          <option value="price-high">Price: High to Low</option>
        </select>
      </div>
      <div class="cart-mini-summary">
        <h4>Cart Summary</h4>
        <p>Total Items: <strong id="miniCount">0</strong></p>
        <p>Subtotal: <strong id="miniTotal">$0.00</strong></p>
        <button class="btn btn-primary" onclick="openCart()">Review & Checkout</button>
      </div>
    </aside>

    <!-- Product Grid -->
    <main class="product-grid" id="productGrid"></main>
  </div>

  <!-- Cart Drawer -->
  <div class="cart-drawer-overlay" id="cartOverlay">
    <div class="cart-drawer">
      <div class="cart-drawer-header">
        <h2>Your Shopping Bag</h2>
        <button class="close-btn" onclick="closeCart()">×</button>
      </div>
      <div class="cart-drawer-body" id="cartItems"></div>
      <div class="cart-drawer-footer">
        <div class="cart-total-row">
          <span>Subtotal:</span>
          <span id="cartSubtotal">$0.00</span>
        </div>
        <button class="btn btn-checkout" onclick="checkout()">Proceed to Secure Checkout 🔒</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script src="app.js"></script>
</body>
</html>'''
    return template.replace("{APP_TITLE}", title)

def _generate_ecom_css() -> str:
    return '''* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --primary: #4f46e5;
  --primary-hover: #4338ca;
  --bg: #0f172a;
  --card-bg: #1e293b;
  --text: #f8fafc;
  --text-muted: #94a3b8;
  --accent: #10b981;
  --border: #334155;
}

body {
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
  background-color: var(--bg);
  color: var(--text);
  line-height: 1.6;
}

.navbar {
  background: rgba(15, 23, 42, 0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 50;
  padding: 1rem 2rem;
}

.nav-container {
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.3rem;
  font-weight: 800;
  color: #fff;
}

.search-bar input {
  background: var(--card-bg);
  border: 1px solid var(--border);
  padding: 0.65rem 1.25rem;
  border-radius: 9999px;
  color: #fff;
  width: 380px;
  outline: none;
}
.search-bar input:focus { border-color: var(--primary); }

.cart-btn {
  background: linear-gradient(135deg, var(--primary), var(--primary-hover));
  color: #fff;
  border: none;
  padding: 0.65rem 1.4rem;
  border-radius: 9999px;
  cursor: pointer;
  font-weight: 600;
  transition: transform 0.2s;
}
.cart-btn:hover { transform: scale(1.05); }

.hero-banner {
  background: radial-gradient(ellipse at top, #1e1b4b 0%, #0f172a 70%);
  padding: 3.5rem 2rem;
  text-align: center;
  border-bottom: 1px solid var(--border);
}
.hero-content h1 { font-size: 2.5rem; margin-top: 0.5rem; font-weight: 800; }
.hero-content p { color: var(--text-muted); font-size: 1.1rem; margin-top: 0.5rem; }
.badge {
  background: rgba(79, 70, 229, 0.2);
  color: #a5b4fc;
  border: 1px solid rgba(79, 70, 229, 0.4);
  padding: 0.35rem 0.85rem;
  border-radius: 9999px;
  font-size: 0.8rem;
  font-weight: 700;
}

.container {
  max-width: 1280px;
  margin: 2.5rem auto;
  padding: 0 1.5rem;
}

.main-content {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 2rem;
}

.sidebar {
  background: var(--card-bg);
  border: 1px solid var(--border);
  padding: 1.5rem;
  border-radius: 16px;
  height: fit-content;
}
.sidebar h3 { font-size: 1.1rem; margin-bottom: 1.2rem; }
.filter-group { margin-bottom: 1.2rem; }
.filter-group label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.4rem; }
.filter-group select {
  width: 100%;
  background: #0f172a;
  border: 1px solid var(--border);
  color: #fff;
  padding: 0.6rem;
  border-radius: 8px;
  outline: none;
}

.cart-mini-summary {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}
.cart-mini-summary h4 { margin-bottom: 0.6rem; font-size: 0.95rem; }
.cart-mini-summary p { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.35rem; }

.product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1.5rem;
}

.product-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: transform 0.2s, box-shadow 0.2s;
}
.product-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
  border-color: var(--primary);
}
.product-image {
  height: 180px;
  background: linear-gradient(135deg, #1e293b, #334155);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 4rem;
}
.product-info { padding: 1.25rem; flex: 1; display: flex; flex-direction: column; }
.product-category { font-size: 0.75rem; text-transform: uppercase; color: #a5b4fc; font-weight: 700; }
.product-title { font-size: 1.1rem; margin: 0.4rem 0 0.8rem; font-weight: 700; color: #fff; }
.product-price-row { display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 1rem; border-top: 1px solid var(--border); }
.product-price { font-size: 1.25rem; font-weight: 800; color: var(--accent); }

.btn {
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: background 0.2s;
}
.btn-primary { background: var(--primary); color: #fff; width: 100%; margin-top: 0.6rem; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-add { background: var(--primary); color: #fff; font-size: 0.9rem; }
.btn-add:hover { background: var(--primary-hover); }

/* Cart Drawer */
.cart-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
  z-index: 100;
  display: none;
  justify-content: flex-end;
}
.cart-drawer-overlay.active { display: flex; }
.cart-drawer {
  background: #1e293b;
  width: 420px;
  max-width: 90vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
  box-shadow: -8px 0 25px rgba(0, 0, 0, 0.5);
}
.cart-drawer-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
.close-btn { background: none; border: none; font-size: 1.8rem; color: #fff; cursor: pointer; }
.cart-drawer-body { flex: 1; overflow-y: auto; padding: 1.5rem 0; }
.cart-item { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--border); }
.cart-item-title { font-size: 0.95rem; font-weight: 600; }
.cart-item-price { color: var(--accent); font-weight: 700; font-size: 0.9rem; }
.cart-remove-btn { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 0.85rem; }
.cart-drawer-footer { border-top: 1px solid var(--border); padding-top: 1.25rem; }
.cart-total-row { display: flex; justify-content: space-between; font-size: 1.2rem; font-weight: 800; margin-bottom: 1rem; }
.btn-checkout { background: var(--accent); color: #000; font-weight: 800; width: 100%; font-size: 1.05rem; padding: 0.85rem; }
.btn-checkout:hover { filter: brightness(1.1); }

.toast {
  position: fixed;
  bottom: 25px;
  right: 25px;
  background: #10b981;
  color: #000;
  font-weight: 700;
  padding: 0.85rem 1.5rem;
  border-radius: 8px;
  box-shadow: 0 10px 25px rgba(0,0,0,0.4);
  transform: translateY(100px);
  opacity: 0;
  transition: all 0.3s ease;
  z-index: 200;
}
.toast.active { transform: translateY(0); opacity: 1; }
'''

def _generate_ecom_js(title: str) -> str:
    template = '''const products = [
  { id: 1, name: "Neural Wireless ANC Headphones", price: 249.99, category: "electronics", icon: "🎧" },
  { id: 2, name: "Smart Holographic Smartwatch v4", price: 389.00, category: "accessories", icon: "⌚" },
  { id: 3, name: "Carbon Fiber Aerodynamic Backpack", price: 129.50, category: "apparel", icon: "🎒" },
  { id: 4, name: "Quantum Studio Mechanical Keyboard", price: 179.99, category: "electronics", icon: "⌨️" },
  { id: 5, name: "Ergonomic Mesh Pro Gaming Chair", price: 449.00, category: "accessories", icon: "🪑" },
  { id: 6, name: "Cyberpunk Stealth Bomber Jacket", price: 199.00, category: "apparel", icon: "🧥" },
  { id: 7, name: "Studio Microphone with Pop Filter", price: 149.00, category: "electronics", icon: "🎙️" },
  { id: 8, name: "Minimalist Titanium Key Ring", price: 49.00, category: "accessories", icon: "🔑" },
];

let cart = [];

function renderProducts() {
  const grid = document.getElementById("productGrid");
  const cat = document.getElementById("categoryFilter").value;
  const sort = document.getElementById("sortFilter").value;
  const search = document.getElementById("searchInput").value.toLowerCase();

  let list = products.filter(p => {
    const matchesCat = cat === "all" || p.category === cat;
    const matchesSearch = p.name.toLowerCase().includes(search);
    return matchesCat && matchesSearch;
  });

  if (sort === "price-low") list.sort((a, b) => a.price - b.price);
  if (sort === "price-high") list.sort((a, b) => b.price - a.price);

  grid.innerHTML = list.map(p => `
    <div class="product-card">
      <div class="product-image">${p.icon}</div>
      <div class="product-info">
        <span class="product-category">${p.category}</span>
        <h4 class="product-title">${p.name}</h4>
        <div class="product-price-row">
          <span class="product-price">$${p.price.toFixed(2)}</span>
          <button class="btn btn-add" onclick="addToCart(${p.id})">Add to Cart</button>
        </div>
      </div>
    </div>
  `).join("");
}

function addToCart(id) {
  const p = products.find(x => x.id === id);
  if (p) {
    cart.push(p);
    updateCartUI();
    showToast(`Added "${p.name}" to cart!`);
  }
}

function removeFromCart(index) {
  cart.splice(index, 1);
  updateCartUI();
}

function updateCartUI() {
  document.getElementById("cartCount").textContent = cart.length;
  document.getElementById("miniCount").textContent = cart.length;
  const total = cart.reduce((sum, item) => sum + item.price, 0);
  document.getElementById("miniTotal").textContent = "$" + total.toFixed(2);
  document.getElementById("cartSubtotal").textContent = "$" + total.toFixed(2);

  const container = document.getElementById("cartItems");
  if (cart.length === 0) {
    container.innerHTML = '<p style="color:#94a3b8; text-align:center; padding:2rem;">Your cart is empty.</p>';
  } else {
    container.innerHTML = cart.map((item, idx) => `
      <div class="cart-item">
        <div>
          <div class="cart-item-title">${item.name}</div>
          <div class="cart-item-price">$${item.price.toFixed(2)}</div>
        </div>
        <button class="cart-remove-btn" onclick="removeFromCart(${idx})">Remove</button>
      </div>
    `).join("");
  }
}

function openCart() {
  document.getElementById("cartOverlay").classList.add("active");
}

function closeCart() {
  document.getElementById("cartOverlay").classList.remove("active");
}

function checkout() {
  if (cart.length === 0) {
    alert("Please add items to cart first!");
    return;
  }
  const total = cart.reduce((sum, item) => sum + item.price, 0);
  alert(`Order Placed Successfully!\\nTotal: $${total.toFixed(2)}\\nThank you for shopping at {APP_TITLE}!`);
  cart = [];
  updateCartUI();
  closeCart();
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("active");
  setTimeout(() => toast.classList.remove("active"), 2500);
}

document.getElementById("categoryFilter").onchange = renderProducts;
document.getElementById("sortFilter").onchange = renderProducts;
document.getElementById("searchInput").oninput = renderProducts;
document.getElementById("cartBtn").onclick = openCart;

renderProducts();
updateCartUI();
'''
    return template.replace("{APP_TITLE}", title)

# ─────────────────────────────────────────────────────────────────────────────
# SAAS / DASHBOARD
# ─────────────────────────────────────────────────────────────────────────────
def _generate_saas_html(title: str) -> str:
    template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{APP_TITLE} — SaaS Analytics Control Center</title>
  <link rel="stylesheet" href="styles.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
  <div class="dashboard-layout">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-icon">⚡</span>
        <span class="brand-name">{APP_TITLE}</span>
      </div>
      <nav class="nav-links">
        <a href="#" class="nav-link active">📊 Overview</a>
        <a href="#" class="nav-link">📈 Analytics</a>
        <a href="#" class="nav-link">💳 Transactions</a>
        <a href="#" class="nav-link">👥 Customers</a>
        <a href="#" class="nav-link">⚙️ Settings</a>
      </nav>
      <div class="sidebar-footer">
        <span class="status-pill">● System Online</span>
      </div>
    </aside>

    <main class="main-body">
      <header class="top-header">
        <div>
          <h1>Real-Time Operations Dashboard</h1>
          <p class="subtitle">Live monitoring metrics compiled by ERA Autonomous Engine.</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-outline" onclick="exportData()">📥 Export CSV</button>
          <button class="btn btn-primary" onclick="simulateNewOrder()">+ New Event</button>
        </div>
      </header>

      <section class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">Monthly Recurring Revenue</span>
          <div class="kpi-value" id="mrrVal">$142,850</div>
          <span class="kpi-trend positive">↑ +18.4% from last month</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Active Platform Users</span>
          <div class="kpi-value" id="usersVal">12,490</div>
          <span class="kpi-trend positive">↑ +1,240 this week</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Conversion Rate</span>
          <div class="kpi-value">4.82%</div>
          <span class="kpi-trend positive">↑ +0.6% vs benchmark</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">System Health</span>
          <div class="kpi-value" style="color: #10b981;">99.99%</div>
          <span class="kpi-trend">Latency: 14ms</span>
        </div>
      </section>

      <section class="chart-section">
        <div class="chart-header">
          <h3>Growth & Activity Stream (Last 7 Days)</h3>
          <span class="tag">Live WebSocket Simulated</span>
        </div>
        <div class="chart-svg-container">
          <svg viewBox="0 0 800 220" class="line-chart">
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#6366f1" stop-opacity="0.4"/>
                <stop offset="100%" stop-color="#6366f1" stop-opacity="0.0"/>
              </linearGradient>
            </defs>
            <path d="M 0 160 Q 120 120, 240 140 T 480 80 T 720 40 L 800 30 L 800 220 L 0 220 Z" fill="url(#chartGrad)"/>
            <path d="M 0 160 Q 120 120, 240 140 T 480 80 T 720 40 L 800 30" fill="none" stroke="#6366f1" stroke-width="4"/>
            <circle cx="240" cy="140" r="6" fill="#6366f1" stroke="#fff" stroke-width="2"/>
            <circle cx="480" cy="80" r="6" fill="#6366f1" stroke="#fff" stroke-width="2"/>
            <circle cx="720" cy="40" r="6" fill="#6366f1" stroke="#fff" stroke-width="2"/>
          </svg>
        </div>
      </section>

      <section class="table-card">
        <div class="table-header">
          <h3>Recent Pipeline Transactions</h3>
          <input type="text" id="txSearch" placeholder="Filter by customer or status..." oninput="filterTable()">
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Customer</th>
              <th>Amount</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody id="txBody"></tbody>
        </table>
      </section>
    </main>
  </div>
  <script src="app.js"></script>
</body>
</html>'''
    return template.replace("{APP_TITLE}", title)

def _generate_saas_css() -> str:
    return '''* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #090d16;
  --sidebar-bg: #0f172a;
  --card-bg: #141e33;
  --border: #1e293b;
  --primary: #6366f1;
  --primary-hover: #4f46e5;
  --accent: #10b981;
  --text: #f8fafc;
  --text-muted: #94a3b8;
}

body {
  font-family: 'Inter', system-ui, sans-serif;
  background-color: var(--bg);
  color: var(--text);
}

.dashboard-layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 260px;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.25rem;
  font-weight: 800;
  color: #fff;
  margin-bottom: 2rem;
}
.brand-icon { font-size: 1.5rem; }

.nav-links { display: flex; flex-direction: column; gap: 0.4rem; flex: 1; }
.nav-link {
  color: var(--text-muted);
  text-decoration: none;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.95rem;
  transition: all 0.2s;
}
.nav-link:hover, .nav-link.active {
  background: rgba(99, 102, 241, 0.15);
  color: #fff;
  border-left: 3px solid var(--primary);
}

.status-pill {
  font-size: 0.8rem;
  color: #34d399;
  font-weight: 600;
}

.main-body { flex: 1; padding: 2rem 2.5rem; overflow-y: auto; }
.top-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
.top-header h1 { font-size: 1.8rem; font-weight: 800; }
.subtitle { color: var(--text-muted); font-size: 0.95rem; margin-top: 0.2rem; }

.header-actions { display: flex; gap: 0.75rem; }
.btn {
  padding: 0.65rem 1.25rem;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-outline { background: transparent; border: 1px solid var(--border); color: #fff; }
.btn-outline:hover { background: rgba(255,255,255,0.05); }

.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.25rem; margin-bottom: 2rem; }
.kpi-card { background: var(--card-bg); border: 1px solid var(--border); padding: 1.5rem; border-radius: 12px; }
.kpi-label { font-size: 0.85rem; color: var(--text-muted); }
.kpi-value { font-size: 2rem; font-weight: 800; margin: 0.4rem 0; color: #fff; }
.kpi-trend { font-size: 0.85rem; color: var(--text-muted); }
.kpi-trend.positive { color: var(--accent); }

.chart-section {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 2rem;
}
.chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.tag { background: rgba(99, 102, 241, 0.2); color: #a5b4fc; padding: 0.3rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; }
.chart-svg-container { width: 100%; height: 220px; }
.line-chart { width: 100%; height: 100%; }

.table-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; }
.table-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; }
.table-header input {
  background: #0f172a;
  border: 1px solid var(--border);
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  width: 280px;
  outline: none;
}
.data-table { width: 100%; border-collapse: collapse; text-align: left; }
.data-table th, .data-table td { padding: 0.85rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.data-table th { color: var(--text-muted); font-weight: 600; }
.badge-status {
  padding: 0.25rem 0.65rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 700;
}
.badge-status.success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
'''

def _generate_saas_js(title: str) -> str:
    template = '''const initialTxs = [
  { id: "TX-9021", customer: "Acme Cloud Corp", amount: "$4,250", tier: "Enterprise", status: "success", time: "2 mins ago" },
  { id: "TX-9020", customer: "NextGen Robotics", amount: "$1,890", tier: "Pro", status: "success", time: "14 mins ago" },
  { id: "TX-9019", customer: "Vanguard Studios", amount: "$990", tier: "Growth", status: "success", time: "1 hour ago" },
  { id: "TX-9018", customer: "Atlas AI Systems", amount: "$6,500", tier: "Enterprise", status: "success", time: "2 hours ago" },
  { id: "TX-9017", customer: "HyperScale Ventures", amount: "$2,400", tier: "Pro", status: "success", time: "4 hours ago" },
];

let txList = [...initialTxs];

function renderTable(data = txList) {
  const tbody = document.getElementById("txBody");
  tbody.innerHTML = data.map(tx => `
    <tr>
      <td style="font-family: monospace; color:#a5b4fc;">${tx.id}</td>
      <td style="font-weight: 600;">${tx.customer}</td>
      <td style="font-weight: 700; color:#34d399;">${tx.amount}</td>
      <td>${tx.tier}</td>
      <td><span class="badge-status ${tx.status}">Completed</span></td>
      <td style="color:#94a3b8;">${tx.time}</td>
    </tr>
  `).join("");
}

function filterTable() {
  const q = document.getElementById("txSearch").value.toLowerCase();
  const filtered = txList.filter(t => t.customer.toLowerCase().includes(q) || t.tier.toLowerCase().includes(q));
  renderTable(filtered);
}

function simulateNewOrder() {
  const customers = ["Apex Dynamics", "Pulse Tech", "Nova Security", "Helios Energy", "Beacon Labs"];
  const tiers = ["Pro", "Enterprise", "Growth"];
  const randCust = customers[Math.floor(Math.random() * customers.length)];
  const randTier = tiers[Math.floor(Math.random() * tiers.length)];
  const randAmt = "$" + (Math.floor(Math.random() * 50) * 100 + 499);
  const newTx = {
    id: "TX-" + Math.floor(1000 + Math.random() * 9000),
    customer: randCust,
    amount: randAmt,
    tier: randTier,
    status: "success",
    time: "Just now"
  };
  txList.unshift(newTx);
  renderTable();

  const userElem = document.getElementById("usersVal");
  const curUsers = parseInt(userElem.textContent.replace(/,/g, ""), 10);
  userElem.textContent = (curUsers + 1).toLocaleString();
}

function exportData() {
  let csv = "ID,Customer,Amount,Tier,Status,Time\\n";
  txList.forEach(t => {
    csv += `${t.id},${t.customer},${t.amount},${t.tier},${t.status},${t.time}\\n`;
  });
  const blob = new Blob([csv], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", "{APP_TITLE}_Transactions.csv");
  a.click();
}

renderTable();
'''
    return template.replace("{APP_TITLE}", title)

# ─────────────────────────────────────────────────────────────────────────────
# KANBAN / TASK BOARD
# ─────────────────────────────────────────────────────────────────────────────
def _generate_kanban_html(title: str) -> str:
    template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{APP_TITLE} — Autonomous Agile Board</title>
  <link rel="stylesheet" href="styles.css">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
  <header class="header">
    <div class="header-left">
      <h2>📋 {APP_TITLE}</h2>
      <span class="badge">Agile Kanban Workspace</span>
    </div>
    <div class="header-actions">
      <button class="btn btn-primary" onclick="openNewCardModal()">+ Add New Task</button>
    </div>
  </header>

  <main class="board">
    <div class="column" id="col-backlog">
      <div class="col-header">
        <h3>Backlog</h3>
        <span class="count" id="count-backlog">0</span>
      </div>
      <div class="cards" id="cards-backlog"></div>
    </div>

    <div class="column" id="col-progress">
      <div class="col-header">
        <h3>In Progress</h3>
        <span class="count" id="count-progress">0</span>
      </div>
      <div class="cards" id="cards-progress"></div>
    </div>

    <div class="column" id="col-review">
      <div class="col-header">
        <h3>Review</h3>
        <span class="count" id="count-review">0</span>
      </div>
      <div class="cards" id="cards-review"></div>
    </div>

    <div class="column" id="col-done">
      <div class="col-header">
        <h3>Completed 🎉</h3>
        <span class="count" id="count-done">0</span>
      </div>
      <div class="cards" id="cards-done"></div>
    </div>
  </main>

  <script src="app.js"></script>
</body>
</html>'''
    return template.replace("{APP_TITLE}", title)

def _generate_kanban_css() -> str:
    return '''* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
  background-color: #0b0f19;
  color: #f8fafc;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.header {
  padding: 1.25rem 2rem;
  background: #111827;
  border-bottom: 1px solid #1f2937;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-left { display: flex; align-items: center; gap: 1rem; }
.badge { background: #1e293b; color: #38bdf8; padding: 0.35rem 0.8rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 700; }
.btn { padding: 0.6rem 1.25rem; border-radius: 8px; font-weight: 600; cursor: pointer; border: none; }
.btn-primary { background: #3b82f6; color: #fff; }
.btn-primary:hover { background: #2563eb; }

.board {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.5rem;
  padding: 2rem;
  overflow-x: auto;
}
.column {
  background: #151d2f;
  border: 1px solid #1e293b;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 120px);
}
.col-header {
  padding: 1rem 1.25rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #1e293b;
}
.col-header h3 { font-size: 1rem; font-weight: 700; }
.count { background: #1e293b; color: #94a3b8; font-size: 0.8rem; padding: 0.2rem 0.6rem; border-radius: 9999px; }

.cards { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.85rem; }
.task-card {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 1rem;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s;
}
.task-card:hover { transform: translateY(-2px); border-color: #3b82f6; }
.task-tag { display: inline-block; font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 4px; margin-bottom: 0.5rem; }
.tag-high { background: rgba(239, 68, 68, 0.2); color: #f87171; }
.tag-med { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
.tag-low { background: rgba(16, 185, 129, 0.2); color: #34d399; }
.task-title { font-size: 0.95rem; font-weight: 600; color: #fff; margin-bottom: 0.5rem; }
.task-footer { display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: #94a3b8; }
.btn-move { background: #334155; color: #fff; border: none; padding: 0.25rem 0.6rem; border-radius: 4px; cursor: pointer; }
.btn-move:hover { background: #3b82f6; }
'''

def _generate_kanban_js(title: str) -> str:
    return '''let tasks = [
  { id: 1, title: "Architect Cloud Distributed Database", tag: "high", status: "backlog", assignee: "ERA AI" },
  { id: 2, title: "Implement Real-time WebSocket Gateway", tag: "med", status: "progress", assignee: "ERA AI" },
  { id: 3, title: "Optimize Neural Voice Inference Model", tag: "high", status: "progress", assignee: "System" },
  { id: 4, title: "Design High-Contrast Responsive Theme", tag: "low", status: "review", assignee: "Design" },
  { id: 5, title: "Automate End-to-End Regression Tests", tag: "med", status: "done", assignee: "QA Bot" },
];

function renderBoard() {
  ["backlog", "progress", "review", "done"].forEach(status => {
    const colCards = tasks.filter(t => t.status === status);
    document.getElementById(`count-${status}`).textContent = colCards.length;
    const container = document.getElementById(`cards-${status}`);
    container.innerHTML = colCards.map(t => `
      <div class="task-card">
        <span class="task-tag tag-${t.tag}">${t.tag.toUpperCase()}</span>
        <div class="task-title">${t.title}</div>
        <div class="task-footer">
          <span>👤 ${t.assignee}</span>
          ${status !== "done" ? `<button class="btn-move" onclick="advanceTask(${t.id})">Next →</button>` : `<span style="color:#10b981;">✓ Done</span>`}
        </div>
      </div>
    `).join("");
  });
}

function advanceTask(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const flow = ["backlog", "progress", "review", "done"];
  const nextIdx = flow.indexOf(t.status) + 1;
  if (nextIdx < flow.length) {
    t.status = flow[nextIdx];
    renderBoard();
  }
}

function openNewCardModal() {
  const title = prompt("Enter task title:");
  if (title && title.trim()) {
    tasks.push({
      id: Date.now(),
      title: title.trim(),
      tag: "med",
      status: "backlog",
      assignee: "You"
    });
    renderBoard();
  }
}

renderBoard();
'''

# ─────────────────────────────────────────────────────────────────────────────
# DEVELOPER PORTFOLIO
# ─────────────────────────────────────────────────────────────────────────────
def _generate_portfolio_html(title: str) -> str:
    template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{APP_TITLE} — Portfolio</title>
  <link rel="stylesheet" href="styles.css">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>
  <nav class="nav">
    <div class="nav-brand">👨‍💻 {APP_TITLE}</div>
    <div class="nav-links">
      <a href="#about">About</a>
      <a href="#projects">Projects</a>
      <a href="#skills">Skills</a>
      <a href="#contact" class="btn-contact">Contact</a>
    </div>
  </nav>

  <header class="hero" id="about">
    <div class="hero-badge">🚀 Autonomous Developer Showcase</div>
    <h1>Creating Next-Gen Systems & Intelligent Interfaces</h1>
    <p>Crafting performant web experiences, AI agents, and resilient full-stack applications.</p>
  </header>

  <section class="section" id="projects">
    <h2>Featured Innovations</h2>
    <div class="projects-grid">
      <div class="project-card">
        <div class="proj-banner">⚡</div>
        <h3>Neural Voice Synthesizer</h3>
        <p>Ultra-low latency duplex streaming voice AI with dynamic pitch matching.</p>
      </div>
      <div class="project-card">
        <div class="proj-banner">🌐</div>
        <h3>Autonomous Outcome Engine</h3>
        <p>Self-healing DAG workflow planner with multi-factor verification.</p>
      </div>
      <div class="project-card">
        <div class="proj-banner">🎮</div>
        <h3>3D WebGL Canvas Engine</h3>
        <p>Hardware accelerated interactive graphics running directly in the browser.</p>
      </div>
    </div>
  </section>

  <script src="app.js"></script>
</body>
</html>'''
    return template.replace("{APP_TITLE}", title)

def _generate_portfolio_css() -> str:
    return '''* { margin:0; padding:0; box-sizing: border-box; }
body { font-family: 'Space Grotesk', system-ui, sans-serif; background: #0a0a0f; color: #f8fafc; }
.nav { display: flex; justify-content: space-between; align-items: center; padding: 1.5rem 3rem; border-bottom: 1px solid #1f2438; }
.nav-brand { font-size: 1.25rem; font-weight: 700; color: #fff; }
.nav-links { display: flex; gap: 1.5rem; align-items: center; }
.nav-links a { color: #94a3b8; text-decoration: none; font-weight: 600; }
.btn-contact { background: #6366f1; color: #fff !important; padding: 0.5rem 1rem; border-radius: 8px; }
.hero { text-align: center; padding: 5rem 2rem; max-width: 800px; margin: 0 auto; }
.hero-badge { display: inline-block; background: rgba(99, 102, 241, 0.2); color: #a5b4fc; padding: 0.4rem 1rem; border-radius: 9999px; margin-bottom: 1.5rem; font-weight: 700; }
.hero h1 { font-size: 3rem; font-weight: 800; line-height: 1.2; margin-bottom: 1rem; }
.hero p { color: #94a3b8; font-size: 1.2rem; }
.section { max-width: 1100px; margin: 3rem auto; padding: 0 2rem; }
.section h2 { font-size: 2rem; margin-bottom: 2rem; text-align: center; }
.projects-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; }
.project-card { background: #131726; border: 1px solid #232a42; border-radius: 12px; padding: 2rem; transition: transform 0.2s; }
.project-card:hover { transform: translateY(-4px); border-color: #6366f1; }
.proj-banner { font-size: 3rem; margin-bottom: 1rem; }
.project-card h3 { font-size: 1.3rem; margin-bottom: 0.5rem; }
.project-card p { color: #94a3b8; line-height: 1.6; }
'''

def _generate_portfolio_js(title: str) -> str:
    return 'console.log("Portfolio initialized.");'

# ─────────────────────────────────────────────────────────────────────────────
# GENERIC CUSTOM APPLICATION
# ─────────────────────────────────────────────────────────────────────────────
def _generate_custom_html(title: str) -> str:
    template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{APP_TITLE} — Autonomous Web Application</title>
  <link rel="stylesheet" href="styles.css">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
  <header class="app-header">
    <div class="header-content">
      <div class="brand">
        <span class="icon">🚀</span>
        <h1>{APP_TITLE}</h1>
      </div>
      <span class="status-tag">● Autonomous Engine Active</span>
    </div>
  </header>

  <main class="container">
    <section class="control-panel">
      <h2>Interactive Command Deck</h2>
      <p class="desc">Engineered autonomously according to requirement: "{APP_TITLE}".</p>
      
      <div class="action-grid">
        <div class="card action-card">
          <h3>⚡ Quick Action</h3>
          <p>Generate simulated activity and test application state.</p>
          <button class="btn btn-primary" onclick="triggerAction()">Execute Action</button>
        </div>
        <div class="card action-card">
          <h3>📊 Real-Time Metric</h3>
          <div class="stat-number" id="liveStat">1,024</div>
          <p>Active Operations Tracked</p>
        </div>
      </div>
    </section>

    <section class="feed-section">
      <h3>Live Operations Log</h3>
      <div class="log-stream" id="logStream">
        <div class="log-item"><span>[Init]</span> Application synthesized and online.</div>
      </div>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>'''
    return template.replace("{APP_TITLE}", title)

def _generate_custom_css() -> str:
    return '''* { margin:0; padding:0; box-sizing: border-box; }
body { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
.app-header { background: #1e293b; border-bottom: 1px solid #334155; padding: 1.25rem 2rem; }
.header-content { max-width: 1000px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
.brand { display: flex; align-items: center; gap: 0.75rem; }
.brand h1 { font-size: 1.4rem; font-weight: 800; color: #38bdf8; }
.status-tag { background: rgba(56, 189, 248, 0.15); color: #38bdf8; padding: 0.35rem 0.85rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 700; }
.container { max-width: 1000px; margin: 2.5rem auto; padding: 0 1.5rem; display: flex; flex-direction: column; gap: 2rem; }
.control-panel h2 { font-size: 1.5rem; font-weight: 700; }
.desc { color: #94a3b8; margin: 0.4rem 0 1.5rem; font-size: 0.95rem; }
.action-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
.card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; }
.card h3 { font-size: 1.1rem; margin-bottom: 0.5rem; }
.card p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1rem; }
.btn { padding: 0.65rem 1.25rem; border-radius: 8px; font-weight: 600; cursor: pointer; border: none; }
.btn-primary { background: #0284c7; color: #fff; }
.btn-primary:hover { background: #0369a1; }
.stat-number { font-size: 2.5rem; font-weight: 800; color: #38bdf8; }
.feed-section { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; }
.feed-section h3 { margin-bottom: 1rem; font-size: 1.1rem; }
.log-stream { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 1rem; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 0.85rem; }
.log-item { padding: 0.35rem 0; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05); }
.log-item span { color: #38bdf8; font-weight: 700; }
'''

def _generate_custom_js(title: str) -> str:
    return '''let count = 1024;
function triggerAction() {
  count += Math.floor(Math.random() * 25) + 1;
  document.getElementById("liveStat").textContent = count.toLocaleString();
  const stream = document.getElementById("logStream");
  const div = document.createElement("div");
  div.className = "log-item";
  div.innerHTML = `<span>[${new Date().toLocaleTimeString()}]</span> Executed live operation cycle #${count}.`;
  stream.prepend(div);
}
'''


# ─────────────────────────────────────────────────────────────────────────────
# 5. RETRO CYBERPUNK ARCADE & SNAKE GAME GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

def _generate_game_html(title: str) -> str:
    template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{APP_TITLE} | Autonomous Arcade</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-[#090D16] text-white min-h-screen flex flex-col items-center justify-center font-mono select-none">
  <div class="w-full max-w-2xl px-4 py-6 flex flex-col items-center">
    <div class="flex items-center justify-between w-full mb-4 px-2">
      <div class="flex items-center gap-3">
        <span class="text-2xl text-amber-400">🎮</span>
        <h1 class="text-xl font-bold tracking-wider text-amber-300">{APP_TITLE}</h1>
      </div>
      <div class="flex items-center gap-6">
        <div class="text-xs text-neutral-400">SCORE: <span id="scoreVal" class="text-amber-400 text-lg font-bold">0</span></div>
        <div class="text-xs text-neutral-400">HIGH: <span id="highScoreVal" class="text-emerald-400 text-lg font-bold">0</span></div>
      </div>
    </div>

    <!-- Canvas Frame -->
    <div class="relative rounded-2xl overflow-hidden border-2 border-amber-500/30 shadow-2xl shadow-amber-500/10 bg-black">
      <canvas id="gameCanvas" width="500" height="500" class="block"></canvas>
      <div id="startOverlay" class="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center">
        <h2 class="text-2xl font-bold text-amber-400 mb-2">{APP_TITLE}</h2>
        <p class="text-xs text-neutral-300 mb-6 max-w-xs">Use Arrow Keys or WASD to navigate. Collect energy crystals and survive.</p>
        <button id="startBtn" class="px-6 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-sm rounded-xl transition transform active:scale-95 shadow-lg shadow-amber-500/30">
          START GAME
        </button>
      </div>
    </div>

    <!-- Virtual D-Pad for Mobile / Quick Click -->
    <div class="mt-4 flex flex-col items-center gap-2 md:hidden">
      <button onclick="simulateKey('ArrowUp')" class="w-12 h-10 bg-neutral-800 rounded-lg text-amber-400 active:bg-neutral-700">▲</button>
      <div class="flex gap-2">
        <button onclick="simulateKey('ArrowLeft')" class="w-12 h-10 bg-neutral-800 rounded-lg text-amber-400 active:bg-neutral-700">◀</button>
        <button onclick="simulateKey('ArrowDown')" class="w-12 h-10 bg-neutral-800 rounded-lg text-amber-400 active:bg-neutral-700">▼</button>
        <button onclick="simulateKey('ArrowRight')" class="w-12 h-10 bg-neutral-800 rounded-lg text-amber-400 active:bg-neutral-700">▶</button>
      </div>
    </div>

    <div class="mt-4 text-[11px] text-neutral-500 flex items-center gap-4">
      <span>Built autonomously by ERA Outcome Engine</span>
      <span>•</span>
      <span>Localhost Active: Port 8080</span>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>'''
    return template.replace("{APP_TITLE}", title)

def _generate_game_css() -> str:
    return '''* { margin:0; padding:0; box-sizing:border-box; }
body { background: #090D16; font-family: monospace; }
canvas { background: #000; }
'''

def _generate_game_js(title: str) -> str:
    return '''const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const scoreVal = document.getElementById("scoreVal");
const highScoreVal = document.getElementById("highScoreVal");
const overlay = document.getElementById("startOverlay");
const startBtn = document.getElementById("startBtn");

const GRID_SIZE = 20;
const TILE_COUNT = canvas.width / GRID_SIZE;

let snake = [{ x: 10, y: 10 }];
let food = { x: 15, y: 15 };
let dx = 1;
let dy = 0;
let score = 0;
let highScore = parseInt(localStorage.getItem("era_game_high") || "0", 10);
let gameInterval = null;
let isRunning = false;

highScoreVal.textContent = highScore;

function resetGame() {
  snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  dx = 1;
  dy = 0;
  score = 0;
  scoreVal.textContent = score;
  placeFood();
}

function placeFood() {
  food.x = Math.floor(Math.random() * TILE_COUNT);
  food.y = Math.floor(Math.random() * TILE_COUNT);
  for (let s of snake) {
    if (s.x === food.x && s.y === food.y) placeFood();
  }
}

function gameLoop() {
  const head = { x: snake[0].x + dx, y: snake[0].y + dy };

  // Wall Wrap
  if (head.x < 0) head.x = TILE_COUNT - 1;
  if (head.x >= TILE_COUNT) head.x = 0;
  if (head.y < 0) head.y = TILE_COUNT - 1;
  if (head.y >= TILE_COUNT) head.y = 0;

  // Self Collision
  for (let s of snake) {
    if (s.x === head.x && s.y === head.y) {
      gameOver();
      return;
    }
  }

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score += 10;
    scoreVal.textContent = score;
    if (score > highScore) {
      highScore = score;
      highScoreVal.textContent = highScore;
      localStorage.setItem("era_game_high", highScore);
    }
    placeFood();
  } else {
    snake.pop();
  }

  draw();
}

function draw() {
  ctx.fillStyle = "#090D16";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw Grid Lines (faint)
  ctx.strokeStyle = "rgba(245, 158, 11, 0.05)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= canvas.width; i += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke();
  }

  // Draw Food
  ctx.fillStyle = "#f59e0b";
  ctx.shadowColor = "#f59e0b";
  ctx.shadowBlur = 10;
  ctx.fillRect(food.x * GRID_SIZE + 2, food.y * GRID_SIZE + 2, GRID_SIZE - 4, GRID_SIZE - 4);
  ctx.shadowBlur = 0;

  // Draw Snake
  snake.forEach((part, index) => {
    ctx.fillStyle = index === 0 ? "#10b981" : "#059669";
    ctx.fillRect(part.x * GRID_SIZE + 1, part.y * GRID_SIZE + 1, GRID_SIZE - 2, GRID_SIZE - 2);
  });
}

function gameOver() {
  clearInterval(gameInterval);
  isRunning = false;
  overlay.classList.remove("hidden");
  overlay.querySelector("h2").textContent = "GAME OVER";
  overlay.querySelector("p").textContent = "Final Score: " + score;
  startBtn.textContent = "PLAY AGAIN";
}

function startGame() {
  resetGame();
  overlay.classList.add("hidden");
  isRunning = true;
  clearInterval(gameInterval);
  gameInterval = setInterval(gameLoop, 100);
}

startBtn.addEventListener("click", startGame);

window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
    e.preventDefault();
  }
  if (!isRunning && e.code === "Space") {
    startGame();
    return;
  }
  if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
    if (dy !== 1) { dx = 0; dy = -1; }
  } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
    if (dy !== -1) { dx = 0; dy = 1; }
  } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
    if (dx !== 1) { dx = -1; dy = 0; }
  } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
    if (dx !== -1) { dx = 1; dy = 0; }
  }
});

function simulateKey(key) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}
draw();
'''
