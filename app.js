(() => {
    "use strict";

    const TEBEX_TOKEN = "11t68-17b9a6ffc9dc73c6c89eef44b6996f825ec19a53";
    const API = `https://headless.tebex.io/api/accounts/${TEBEX_TOKEN}`;
    const BASKET_API = `https://headless.tebex.io/api/baskets`;
    const WEBSTORE = "https://taxsmps.tebex.io";
    const DISCORD_INVITE = "https://discord.gg/3eSTqYaAuR";

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const fmt = (n, ccy = "USD") => {
        try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(n); }
        catch { return `$${Number(n).toFixed(2)}`; }
    };

    const sanitize = (html) => {
        const div = document.createElement("div");
        div.innerHTML = html || "";
        const text = div.textContent || "";
        return text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    };

    /* ========== Storage ========== */
    const Store = {
        get user() { return localStorage.getItem("taxsmp_user") || ""; },
        set user(v) { v ? localStorage.setItem("taxsmp_user", v) : localStorage.removeItem("taxsmp_user"); },
        get cart() {
            try { return JSON.parse(localStorage.getItem("taxsmp_cart") || "[]"); }
            catch { return []; }
        },
        set cart(items) { localStorage.setItem("taxsmp_cart", JSON.stringify(items)); }
    };

    /* ========== Toast ========== */
    const toast = (msg, isErr = false) => {
        const t = $("#toast");
        if (!t) return;
        t.textContent = msg;
        t.classList.toggle("error", isErr);
        t.classList.add("show");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove("show"), 2400);
    };

    /* ========== Particles ========== */
    const initParticles = () => {
        const canvas = $("#particles");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        let particles;
        const COUNT = Math.min(60, Math.floor(window.innerWidth / 22));

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = window.innerWidth * dpr;
            canvas.height = window.innerHeight * dpr;
            canvas.style.width = window.innerWidth + "px";
            canvas.style.height = window.innerHeight + "px";
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
        };
        const spawn = () => {
            particles = Array.from({ length: COUNT }, () => ({
                x: Math.random() * window.innerWidth,
                y: Math.random() * window.innerHeight,
                r: Math.random() * 1.4 + 0.3,
                vx: (Math.random() - 0.5) * 0.22,
                vy: (Math.random() - 0.5) * 0.22,
                a: Math.random() * 0.5 + 0.2,
                hue: Math.random() > 0.5 ? 200 : 260
            }));
        };
        const tick = () => {
            ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
            for (const p of particles) {
                p.x += p.vx; p.y += p.vy;
                if (p.x < 0) p.x = window.innerWidth;
                if (p.x > window.innerWidth) p.x = 0;
                if (p.y < 0) p.y = window.innerHeight;
                if (p.y > window.innerHeight) p.y = 0;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, ${p.a})`;
                ctx.shadowColor = `hsla(${p.hue}, 100%, 70%, 0.6)`;
                ctx.shadowBlur = 8;
                ctx.fill();
            }
            requestAnimationFrame(tick);
        };
        resize(); spawn(); tick();
        window.addEventListener("resize", () => { resize(); spawn(); });
    };

    /* ========== Copy IP ========== */
    const initCopyIp = () => {
        $$(".tile-ip").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const ip = btn.dataset.ip;
                try { await navigator.clipboard.writeText(ip); toast(`Copied ${ip}`); }
                catch { toast(ip); }
            });
        });
    };

    /* ========== Landing tile handlers ========== */
    const initLanding = () => {
        $$('[data-tile="stats"]').forEach(t => {
            t.addEventListener("click", (e) => { e.preventDefault(); toast("Stats coming soon"); });
        });
        $$('[data-tile="join"]').forEach(t => {
            t.addEventListener("click", (e) => { e.preventDefault(); toast("Connect to play.taxsmp.net in Minecraft"); });
        });
        $$('[data-tile="logo"]').forEach(t => {
            t.addEventListener("click", (e) => { e.preventDefault(); });
        });
    };

    /* ========== Store data ========== */
    const TIER_META = {
        "+ Rank":    { tier: 1, icon: "✦", sub: "Starter perks for active players" },
        "++ Rank":   { tier: 2, icon: "✧", sub: "Step up with extra utilities" },
        "+++ Rank":  { tier: 3, icon: "✪", sub: "Power-user features and conveniences" },
        "++++ Rank": { tier: 4, icon: "✫", sub: "The full TaxSMP experience" }
    };

    let storeData = { ranks: [], keys: [], gems: [] };
    let activeRankIdx = 0;
    const qtySelection = new Map(); // package_id -> selected qty
    let pendingAction = null;       // function to run once username is set

    const loadStore = async () => {
        try {
            const res = await fetch(`${API}/categories?includePackages=1`, { headers: { Accept: "application/json" } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const cats = (json.data || []);
            const ranks = (cats.find(c => /rank/i.test(c.name))?.packages || [])
                .slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));
            const keys = (cats.find(c => /crate|key/i.test(c.name))?.packages || [])
                .slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));
            const gems = (cats.find(c => /gem|rub(y|ies)|crystal|coin|token|currency/i.test(c.name))?.packages || [])
                .slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));
            storeData = { ranks, keys, gems };
            renderRanks();
            renderKeys();
            renderGems();
            setCategoryArt();
            $("#loading")?.classList.add("hidden");
        } catch (err) {
            console.error(err);
            const loading = $("#loading");
            if (loading) {
                loading.innerHTML = `<p style="color:var(--text-dim)">Couldn't load store. <a href="${WEBSTORE}" style="color:var(--brand-blue);text-decoration:underline" target="_blank" rel="noopener">Visit Tebex directly →</a></p>`;
            }
        }
    };

    const renderRanks = () => {
        const tabsEl = $("#rank-tabs");
        const featuredEl = $("#rank-featured");
        if (!tabsEl || !featuredEl) return;

        tabsEl.innerHTML = storeData.ranks.map((r, i) => `
            <button type="button" class="rank-tab ${i === activeRankIdx ? "active" : ""}" data-idx="${i}">
                ${r.name}
            </button>
        `).join("");

        tabsEl.querySelectorAll(".rank-tab").forEach(btn => {
            btn.addEventListener("click", () => {
                activeRankIdx = parseInt(btn.dataset.idx, 10);
                renderRanks();
            });
        });

        const rank = storeData.ranks[activeRankIdx];
        if (!rank) { featuredEl.innerHTML = ""; return; }
        const meta = TIER_META[rank.name] || { tier: 1, icon: "✦", sub: "" };
        const perks = sanitize(rank.description);
        const subPeriod = rank.expiry_period
            ? `per ${rank.expiry_period.count > 1 ? rank.expiry_period.count + " " : ""}${rank.expiry_period.unit}${rank.expiry_period.count > 1 ? "s" : ""}`
            : "one-time";

        featuredEl.className = `rank-featured tier-${meta.tier}`;
        featuredEl.innerHTML = `
            <div class="rank-info">
                <h2 class="rank-name">
                    <span class="rank-icon">${rank.image ? `<img src="${rank.image}" alt="" />` : meta.icon}</span>
                    ${rank.name}
                </h2>
                <p class="rank-sub">${meta.sub}</p>
                <ul class="rank-perks">
                    ${perks.map(p => `<li>${p}</li>`).join("")}
                </ul>
                <div class="rank-buy-row">
                    <div>
                        <div class="rank-price">${fmt(rank.base_price, rank.currency)}</div>
                        <span class="rank-price-sub">${subPeriod}</span>
                    </div>
                    <button class="btn-buy-rank" data-buy-rank="${rank.id}">Add to Cart</button>
                </div>
            </div>
            <div class="rank-art">
                ${rank.image ? `<img src="${rank.image}" alt="${rank.name}" />` : `<div style="font-size:120px">${meta.icon}</div>`}
            </div>
        `;

        featuredEl.querySelector("[data-buy-rank]").addEventListener("click", () => {
            requestAddToCart(rank, 1);
        });
    };

    // Each category card shows a random image from its own packages.
    const setCategoryArt = () => {
        const pick = (arr) => {
            const withImg = (arr || []).filter(p => p.image);
            return withImg.length ? withImg[Math.floor(Math.random() * withImg.length)].image : "";
        };
        const apply = (sel, img) => {
            const el = $(sel);
            if (el && img) el.innerHTML = `<img src="${img}" alt="" />`;
        };
        apply(".cat-ranks .cat-art", pick(storeData.ranks));
        apply(".cat-crates .cat-art", pick(storeData.keys));
        apply(".cat-gems .cat-art", pick(storeData.gems));
    };

    const renderKeys = () => buildPackageGrid($("#key-grid"), storeData.keys);

    const renderGems = () => {
        const grid = $("#gem-grid");
        if (!grid) return;
        const section = $("#gems-section");
        const card = $("#gems-card");
        if (!storeData.gems.length) {
            section?.classList.add("hidden");
            card?.classList.add("hidden");
            return;
        }
        buildPackageGrid(grid, storeData.gems);
    };

    const buildPackageGrid = (grid, packages) => {
        if (!grid) return;
        grid.innerHTML = packages.map(k => {
            const qty = qtySelection.get(k.id) || 1;
            return `
                <article class="key-card" data-key="${k.id}">
                    <div class="key-image-wrap">
                        ${k.image ? `<img src="${k.image}" alt="${k.name}" />` : ""}
                    </div>
                    <h3 class="key-name">${k.name}</h3>
                    <div class="key-price">${fmt(k.base_price, k.currency)}</div>
                    <div class="qty-pills" role="radiogroup">
                        ${[1, 5, 10, 20].map(q => `
                            <button type="button" class="qty-pill ${q === qty ? "active" : ""}" data-qty="${q}">${q}x</button>
                        `).join("")}
                    </div>
                    <button type="button" class="btn-add" data-add="${k.id}">Add to Cart</button>
                </article>
            `;
        }).join("");

        grid.querySelectorAll(".key-card").forEach(card => {
            const id = parseInt(card.dataset.key, 10);
            card.querySelectorAll(".qty-pill").forEach(pill => {
                pill.addEventListener("click", () => {
                    const q = parseInt(pill.dataset.qty, 10);
                    qtySelection.set(id, q);
                    card.querySelectorAll(".qty-pill").forEach(p => p.classList.toggle("active", p === pill));
                });
            });
            card.querySelector("[data-add]").addEventListener("click", () => {
                const pkg = packages.find(k => k.id === id);
                const q = qtySelection.get(id) || 1;
                requestAddToCart(pkg, q);
            });
        });
    };

    /* ========== Cart ========== */
    const updateCartBadge = () => {
        const badge = $("#cart-count");
        if (!badge) return;
        const total = Store.cart.reduce((s, i) => s + i.quantity, 0);
        badge.textContent = total;
        badge.classList.remove("bump");
        void badge.offsetWidth;
        badge.classList.add("bump");
    };

    const doAddToCart = (pkg, quantity) => {
        const cart = Store.cart;
        const existing = cart.find(i => i.id === pkg.id);
        if (existing) {
            existing.quantity = pkg.type === "subscription" ? 1 : existing.quantity + quantity;
        } else {
            cart.push({
                id: pkg.id,
                name: pkg.name,
                price: pkg.base_price,
                currency: pkg.currency || "USD",
                image: pkg.image || "",
                type: pkg.type || "single",
                quantity: pkg.type === "subscription" ? 1 : quantity
            });
        }
        Store.cart = cart;
        updateCartBadge();
        toast(`Added ${pkg.type === "subscription" ? "" : quantity + "× "}${pkg.name}`);
        openCart();
    };

    // Asks for username first if not set, then runs the add.
    const requestAddToCart = (pkg, quantity) => {
        if (!Store.user) {
            pendingAction = () => doAddToCart(pkg, quantity);
            showUserModal();
            return;
        }
        doAddToCart(pkg, quantity);
    };

    const removeFromCart = (id) => {
        Store.cart = Store.cart.filter(i => i.id !== id);
        renderCart();
        updateCartBadge();
    };

    const setQty = (id, qty) => {
        const cart = Store.cart;
        const item = cart.find(i => i.id === id);
        if (!item) return;
        if (qty < 1) return removeFromCart(id);
        if (item.type === "subscription") qty = 1;
        item.quantity = qty;
        Store.cart = cart;
        renderCart();
        updateCartBadge();
    };

    const renderCart = () => {
        const itemsEl = $("#cart-items");
        const emptyEl = $("#cart-empty");
        const footerEl = $("#cart-footer");
        const totalEl = $("#cart-total");
        if (!itemsEl) return;
        const cart = Store.cart;
        if (!cart.length) {
            itemsEl.innerHTML = "";
            emptyEl.classList.remove("hidden");
            footerEl.classList.add("hidden");
            return;
        }
        emptyEl.classList.add("hidden");
        footerEl.classList.remove("hidden");

        itemsEl.innerHTML = cart.map(it => `
            <div class="cart-item" data-id="${it.id}">
                <div class="cart-item-img">${it.image ? `<img src="${it.image}" alt="" />` : ""}</div>
                <div class="cart-item-info">
                    <p class="cart-item-name">${it.name}</p>
                    <div class="cart-item-meta">
                        ${it.type === "subscription"
                            ? `<span>Subscription</span>`
                            : `<div class="cart-qty">
                                    <button type="button" data-dec aria-label="Decrease">−</button>
                                    <span>${it.quantity}</span>
                                    <button type="button" data-inc aria-label="Increase">+</button>
                                </div>`
                        }
                    </div>
                </div>
                <div class="cart-item-actions">
                    <span class="cart-item-price">${fmt(it.price * it.quantity, it.currency)}</span>
                    <button type="button" class="cart-item-remove" data-remove>Remove</button>
                </div>
            </div>
        `).join("");

        itemsEl.querySelectorAll(".cart-item").forEach(row => {
            const id = parseInt(row.dataset.id, 10);
            row.querySelector("[data-inc]")?.addEventListener("click", () => {
                const it = Store.cart.find(i => i.id === id);
                setQty(id, it.quantity + 1);
            });
            row.querySelector("[data-dec]")?.addEventListener("click", () => {
                const it = Store.cart.find(i => i.id === id);
                setQty(id, it.quantity - 1);
            });
            row.querySelector("[data-remove]")?.addEventListener("click", () => removeFromCart(id));
        });

        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        const ccy = cart[0]?.currency || "USD";
        totalEl.textContent = fmt(total, ccy);
    };

    const openCart = () => {
        renderCart();
        $("#cart-drawer")?.classList.remove("hidden");
    };
    const closeCart = () => $("#cart-drawer")?.classList.add("hidden");

    /* ========== Username modal ========== */
    const showUserModal = () => {
        const m = $("#user-modal");
        if (!m) return;
        // Close cart drawer first so the modal isn't blocked visually.
        // (Modal has higher z-index anyway, but it feels cleaner.)
        m.classList.remove("hidden");
        const input = $("#user-input");
        if (input) {
            input.value = Store.user || "";
            setTimeout(() => input.focus(), 60);
        }
    };
    const hideUserModal = () => {
        $("#user-modal")?.classList.add("hidden");
        pendingAction = null;
    };

    const updateUserBanner = () => {
        const banner = $("#user-banner");
        if (!banner) return;
        const u = Store.user;
        if (u) {
            $("#user-name").textContent = u;
            banner.classList.remove("hidden");
        } else {
            banner.classList.add("hidden");
        }
    };

    /* ========== Checkout ========== */
    const doCheckout = async () => {
        const btn = $("#checkout-btn");
        const label = $("#checkout-label");
        const items = Store.cart;
        if (!items.length) return;

        if (!Store.user) {
            pendingAction = doCheckout;
            showUserModal();
            return;
        }

        btn.disabled = true;
        label.textContent = "Building basket…";
        try {
            // Tebex only accepts http(s) URLs. Fall back to the webstore when running from file://
            const proto = window.location.protocol;
            const onWeb = proto === "http:" || proto === "https:";
            const base = onWeb ? (window.location.origin + window.location.pathname) : WEBSTORE;
            const basketRes = await fetch(`${API}/baskets`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                    complete_url: base + "?status=complete",
                    cancel_url: base + "?status=cancel",
                    complete_auto_redirect: true,
                    username: Store.user
                })
            });
            if (!basketRes.ok) {
                const err = await basketRes.json().catch(() => ({}));
                throw new Error(err.detail || `Couldn't create basket (HTTP ${basketRes.status})`);
            }
            const basketJson = await basketRes.json();
            const ident = basketJson.data.ident;

            label.textContent = "Adding items…";
            let lastResponse = null;
            for (const item of items) {
                const addRes = await fetch(`${BASKET_API}/${ident}/packages`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify({
                        package_id: item.id,
                        quantity: item.quantity,
                        type: item.type === "subscription" ? "subscription" : "single"
                    })
                });
                if (!addRes.ok) {
                    const err = await addRes.json().catch(() => ({}));
                    throw new Error(err.detail || `Couldn't add ${item.name}`);
                }
                lastResponse = await addRes.json();
            }

            const checkoutUrl = lastResponse?.data?.links?.checkout
                || `https://pay.tebex.io/${ident}`;

            label.textContent = "Redirecting…";
            Store.cart = [];
            window.location.assign(checkoutUrl);
        } catch (err) {
            console.error(err);
            toast(err.message || "Checkout failed. Try again.", true);
            btn.disabled = false;
            label.textContent = "Checkout";
        }
    };

    /* ========== Store init ========== */
    const initStore = () => {
        loadStore();
        updateCartBadge();
        updateUserBanner();

        $("#cart-btn")?.addEventListener("click", openCart);
        $$("[data-close-cart]").forEach(el => el.addEventListener("click", closeCart));
        $$("[data-close-modal]").forEach(el => el.addEventListener("click", hideUserModal));

        // Submit username form
        $("#user-form")?.addEventListener("submit", (e) => {
            e.preventDefault();
            const val = $("#user-input").value.trim();
            if (!/^[A-Za-z0-9_]{3,16}$/.test(val)) {
                toast("Username must be 3–16 letters, numbers or underscores", true);
                return;
            }
            Store.user = val;
            updateUserBanner();
            $("#user-modal").classList.add("hidden");
            toast(`Welcome, ${val}!`);
            // Resume whatever the user was trying to do
            const action = pendingAction;
            pendingAction = null;
            if (action) setTimeout(action, 100);
        });

        $("#change-user")?.addEventListener("click", () => showUserModal());

        $("#checkout-btn")?.addEventListener("click", doCheckout);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { closeCart(); hideUserModal(); }
        });

        // Status from Tebex return
        const params = new URLSearchParams(window.location.search);
        if (params.get("status") === "complete") {
            toast("Thanks for your purchase! Items will be delivered in-game.");
            history.replaceState({}, "", window.location.pathname);
        } else if (params.get("status") === "cancel") {
            toast("Payment cancelled.", true);
            history.replaceState({}, "", window.location.pathname);
        }
    };

    /* ========== Boot ========== */
    document.addEventListener("DOMContentLoaded", () => {
        initParticles();
        initCopyIp();
        if (document.body.classList.contains("store-page")) {
            initStore();
        } else {
            initLanding();
        }
    });
})();
