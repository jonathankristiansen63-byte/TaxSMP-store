(() => {
    "use strict";

    const TEBEX_TOKEN = "12b00-c57914f7265cf8a78648a0126a224d95f4635fde";
    const API = `https://headless.tebex.io/api/accounts/${TEBEX_TOKEN}`;
    const BASKET_API = `https://headless.tebex.io/api/baskets`;
    const WEBSTORE = "https://taxsmp-store.tebex.io";
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
        get platform() { return localStorage.getItem("taxsmp_platform") === "bedrock" ? "bedrock" : "java"; },
        set platform(v) { localStorage.setItem("taxsmp_platform", v === "bedrock" ? "bedrock" : "java"); },
        // Bedrock only: the resolved Xbox XUID (Floodgate identity) for the
        // current player. Lets us send a verified account to Tebex instead of
        // relying on the raw text the player typed.
        get xuid() { return localStorage.getItem("taxsmp_xuid") || ""; },
        set xuid(v) { v ? localStorage.setItem("taxsmp_xuid", v) : localStorage.removeItem("taxsmp_xuid"); },
        get cart() {
            try { return JSON.parse(localStorage.getItem("taxsmp_cart") || "[]"); }
            catch { return []; }
        },
        set cart(items) { localStorage.setItem("taxsmp_cart", JSON.stringify(items)); }
    };

    // This store is a Tebex "Geyser (Dot Prefix)" webstore, so Bedrock players
    // MUST be sent with a leading "." — Tebex resolves the dotted name against
    // the player's real Xbox gamertag. Without it, Tebex does a Java/Mojang
    // lookup and returns 404 "Invalid Username provided".
    const FLOODGATE_PREFIX = ".";

    // The name shown in the UI (plain, as typed). Java names are used as-is;
    // Bedrock we show with the dot so it's clear it's the Geyser account.
    const deliveryUsername = () => {
        const name = Store.user;
        if (!name) return name;
        return (Store.platform === "bedrock" && !name.startsWith(FLOODGATE_PREFIX))
            ? FLOODGATE_PREFIX + name
            : name;
    };

    // The tricky part: what a Bedrock player TYPES is their in-game Floodgate
    // name (e.g. "hero_brine8026") — Floodgate lowercases and turns spaces into
    // "_". But Tebex needs the REAL Xbox gamertag with correct spaces AND
    // capitalisation (".Hero brine8026"). So for Bedrock we look the typed name
    // up against the GeyserMC global API (the same source Tebex uses) to find
    // the player's Xbox account by XUID, then send the canonical gamertag.
    // Java names go straight through.
    const GEYSER_API = "https://api.geysermc.org/v2/xbox";

    // Build every plausible spelling of a typed Bedrock name, most-likely first.
    // A player might type their Floodgate in-game name ("hero_brine8026"), their
    // real gamertag with spaces ("Hero brine8026"), or a mix — all of which map
    // to the same Xbox account, so we try each until one resolves.
    const bedrockCandidates = (typed) => {
        const t = typed.trim().replace(/\s+/g, " ");
        // Floodgate turns spaces into "_", so the space form is the likeliest
        // real gamertag. Keep the verbatim/underscore forms as fallbacks.
        return [...new Set([
            t.replace(/_/g, " "),   // "hero brine8026"
            t,                       // exactly as typed
            t.replace(/[_ ]+/g, " ") // collapse any mix of "_" and spaces
        ])].filter(Boolean);
    };

    // Resolve a typed Bedrock name to a verified Xbox account. Returns
    // { xuid, gamertag } (gamertag correctly cased/spaced) or null when no
    // account matches any spelling — i.e. the name really is invalid.
    const resolveBedrock = async (typed) => {
        for (const cand of bedrockCandidates(typed)) {
            try {
                const xr = await fetch(`${GEYSER_API}/xuid/${encodeURIComponent(cand)}`);
                if (!xr.ok) continue;
                const data = await xr.json().catch(() => ({}));
                const xuid = data && data.xuid != null ? String(data.xuid) : "";
                if (!xuid) continue;
                // Look the XUID back up to recover the correctly-cased gamertag.
                let gamertag = cand;
                try {
                    const gr = await fetch(`${GEYSER_API}/gamertag/${encodeURIComponent(xuid)}`);
                    if (gr.ok) {
                        const g = await gr.json().catch(() => ({}));
                        if (g && g.gamertag) gamertag = g.gamertag;
                    }
                } catch { /* keep the candidate spelling */ }
                return { xuid, gamertag };
            } catch { /* try next candidate */ }
        }
        return null; // no Xbox account matched — the name is genuinely invalid
    };

    // Used at checkout as a safety net (e.g. names stored before resolution ran).
    // Turns the typed/stored Bedrock name into the dotted gamertag Tebex expects.
    const resolveTebexUsername = async (typed, platform) => {
        if (platform !== "bedrock") return typed;              // Java: send as-is
        if (typed.startsWith(FLOODGATE_PREFIX)) return typed;  // already dotted
        const res = await resolveBedrock(typed);
        return res ? FLOODGATE_PREFIX + res.gamertag : null;
    };

    // Validation + hint per edition. Tebex resolves the dotted Bedrock name via
    // Xbox; the in-game (Floodgate) name only contains [A-Za-z0-9_], so we
    // validate against that same charset for both editions. Do NOT send the "."
    // here — deliveryUsername() adds it; the user types their plain name.
    const PLATFORM_RULES = {
        java: {
            re: /^[A-Za-z0-9_]{3,16}$/,
            pattern: "[A-Za-z0-9_]+",
            placeholder: "e.g. Notch",
            hint: "3–16 characters. Letters, numbers and underscores only.",
            error: "Java username must be 3–16 letters, numbers or underscores"
        },
        bedrock: {
            // Allow spaces too: some players type their real gamertag ("Hero brine8026")
            // rather than the Floodgate in-game name ("hero_brine8026"). We resolve
            // either form to the canonical gamertag before checkout.
            re: /^[A-Za-z0-9_ ]{3,16}$/,
            pattern: "[A-Za-z0-9_ ]+",
            placeholder: "e.g. Hero brine8026",
            hint: "Type your in-game name — we verify it against Xbox automatically.",
            error: "Bedrock gamertag must be 3–16 letters, numbers, spaces or underscores"
        }
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
                hue: Math.random() > 0.5 ? 45 : 38
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

    // Skin head for the "signed in as" row. Java names resolve to the real
    // skin; Bedrock/dotted names fall back to a Steve head via mc-heads.
    const skinHeadUrl = (name) => `https://mc-heads.net/avatar/${encodeURIComponent(name || "Steve")}/40`;

    const renderCart = () => {
        const rowsEl = $("#checkout-rows");
        const tableEl = $("#checkout-table");
        const emptyEl = $("#checkout-empty");
        const ctaEl = $("#checkout-cta");
        const totalEl = $("#checkout-total");
        if (!rowsEl) return;
        const cart = Store.cart;
        const ccy = cart[0]?.currency || "USD";

        // Account row (always reflects the current player)
        const display = deliveryUsername() || "Not signed in";
        $("#account-name").textContent = display;
        const head = $("#account-head");
        if (head) {
            head.onerror = () => { head.onerror = null; head.src = skinHeadUrl("Steve"); };
            head.src = skinHeadUrl(Store.user);
        }
        $("#currency-label").textContent = ccy;

        if (!cart.length) {
            rowsEl.innerHTML = "";
            tableEl.classList.add("hidden");
            ctaEl.classList.add("hidden");
            emptyEl.classList.remove("hidden");
            totalEl.textContent = fmt(0, ccy);
            return;
        }
        emptyEl.classList.add("hidden");
        tableEl.classList.remove("hidden");
        ctaEl.classList.remove("hidden");

        rowsEl.innerHTML = cart.map(it => `
            <div class="checkout-row" data-id="${it.id}">
                <div class="co-name">
                    ${it.image ? `<img class="co-icon" src="${it.image}" alt="" />` : ""}
                    <span>${it.name}</span>
                </div>
                <div class="co-price">${fmt(it.price * it.quantity, it.currency)}</div>
                <div class="co-qty">
                    ${it.type === "subscription"
                        ? `<span class="qty-box qty-fixed">${it.quantity}</span>`
                        : `<span class="qty-box">
                                <button type="button" class="qty-step" data-dec aria-label="Decrease">−</button>
                                <span class="qty-num">${it.quantity}</span>
                                <button type="button" class="qty-step" data-inc aria-label="Increase">+</button>
                            </span>`
                    }
                    <button type="button" class="row-btn row-info" data-info aria-label="Details">i</button>
                    <button type="button" class="row-btn row-remove" data-remove aria-label="Remove">✕</button>
                </div>
            </div>
        `).join("");

        rowsEl.querySelectorAll(".checkout-row").forEach(row => {
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
            row.querySelector("[data-info]")?.addEventListener("click", () => {
                const it = Store.cart.find(i => i.id === id);
                if (it) toast(`${it.name} — ${it.type === "subscription" ? "Recurring subscription" : "One-time purchase"}`);
            });
        });

        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        totalEl.textContent = fmt(total, ccy);
    };

    const openCart = () => {
        renderCart();
        $("#checkout-screen")?.classList.remove("hidden");
        document.body.classList.add("checkout-open");
    };
    const closeCart = () => {
        $("#checkout-screen")?.classList.add("hidden");
        document.body.classList.remove("checkout-open");
    };

    /* ========== Username modal ========== */
    let modalPlatform = "java"; // edition currently selected in the modal

    // Reflect the chosen edition in the toggle UI, input rules and hint text.
    const applyPlatform = (platform) => {
        modalPlatform = platform === "bedrock" ? "bedrock" : "java";
        const rules = PLATFORM_RULES[modalPlatform];
        $$("#platform-toggle .platform-opt").forEach(btn => {
            const on = btn.dataset.platform === modalPlatform;
            btn.classList.toggle("active", on);
            btn.setAttribute("aria-checked", on ? "true" : "false");
        });
        const input = $("#user-input");
        if (input) {
            input.setAttribute("pattern", rules.pattern);
            input.placeholder = rules.placeholder;
        }
        const hint = $("#user-hint");
        if (hint) hint.textContent = rules.hint;
    };

    const showUserModal = () => {
        const m = $("#user-modal");
        if (!m) return;
        // Close cart drawer first so the modal isn't blocked visually.
        // (Modal has higher z-index anyway, but it feels cleaner.)
        m.classList.remove("hidden");
        applyPlatform(Store.user ? Store.platform : modalPlatform);
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

    // Toggle the "Finding your account…" busy state on the username form while
    // we verify a Bedrock name against Xbox.
    const setUserFormBusy = (busy, label) => {
        const btn = $("#user-form .btn-primary");
        const input = $("#user-input");
        if (input) input.disabled = busy;
        if (!btn) return;
        if (busy) {
            btn.dataset.label = btn.dataset.label || btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${label || "Please wait…"}`;
        } else {
            btn.disabled = false;
            if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
        }
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
        try {
            // For Bedrock, turn the typed in-game name into the real Xbox gamertag
            // Tebex can resolve. Java names pass straight through.
            label.textContent = Store.platform === "bedrock" ? "Finding your account…" : "Building basket…";
            const tebexUsername = await resolveTebexUsername(Store.user, Store.platform);
            if (!tebexUsername) {
                throw new Error(`We couldn't find "${Store.user}" as a Bedrock player. Type your Xbox gamertag exactly as it shows on your account (including spaces), then try again.`);
            }

            label.textContent = "Building basket…";
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
                    username: tebexUsername
                })
            });
            if (!basketRes.ok) {
                const err = await basketRes.json().catch(() => ({}));
                // Tebex puts the message in `title` (detail is usually empty).
                const reason = err.detail || err.title || `HTTP ${basketRes.status}`;
                // 404 "Invalid Username provided" means the name still didn't
                // resolve — usually the edition toggle is on the wrong platform.
                if (basketRes.status === 404 && /username/i.test(reason)) {
                    throw new Error(`We couldn't find "${Store.user}" as a ${Store.platform === "bedrock" ? "Bedrock" : "Java"} player. Check the Java/Bedrock toggle matches your edition and try again.`);
                }
                throw new Error(`Couldn't create basket (${reason})`);
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
            label.textContent = "Proceed to checkout »";
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

        // Edition toggle (Java / Bedrock)
        $$("#platform-toggle .platform-opt").forEach(btn => {
            btn.addEventListener("click", () => {
                applyPlatform(btn.dataset.platform);
                $("#user-input")?.focus();
            });
        });

        // Submit username form
        $("#user-form")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const rules = PLATFORM_RULES[modalPlatform];
            const val = $("#user-input").value.trim().replace(/\s+/g, " ");
            if (!rules.re.test(val)) {
                toast(rules.error, true);
                return;
            }

            let displayName = val;
            if (modalPlatform === "bedrock") {
                // Resolve the typed name to a real Xbox account by XUID so it
                // works even when the in-game name "looks" wrong (underscores
                // vs spaces, casing). Only a name with no matching Xbox account
                // is treated as invalid.
                setUserFormBusy(true, "Finding your account…");
                const resolved = await resolveBedrock(val);
                setUserFormBusy(false);
                if (!resolved) {
                    toast(`We couldn't find "${val}" on Xbox Live. Double-check your Bedrock name and try again.`, true);
                    return;
                }
                Store.platform = "bedrock";
                Store.user = resolved.gamertag; // canonical caps/spaces
                Store.xuid = resolved.xuid;
                displayName = deliveryUsername(); // ".Hero brine8026"
            } else {
                Store.platform = "java";
                Store.user = val;
                Store.xuid = "";
            }
            updateUserBanner();
            renderCart(); // keep the checkout account row in sync
            $("#user-modal").classList.add("hidden");
            toast(`Welcome, ${displayName}!`);
            // Resume whatever the user was trying to do
            const action = pendingAction;
            pendingAction = null;
            if (action) setTimeout(action, 100);
        });

        $("#change-user")?.addEventListener("click", () => showUserModal());
        $("#switch-account")?.addEventListener("click", () => showUserModal());
        $("#currency-select")?.addEventListener("click", () => {
            const ccy = Store.cart[0]?.currency || "USD";
            toast(`Prices are shown in ${ccy} (set by the store)`);
        });

        $("#checkout-btn")?.addEventListener("click", doCheckout);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { closeCart(); hideUserModal(); closeLegal(); }
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

    /* ========== Legal (Terms / Privacy / Refunds) ========== */
    const LEGAL_UPDATED = "22 July 2026";
    const LEGAL = {
        terms: {
            title: "Terms of Service",
            body: `
                <p>Welcome to the TaxSMP store. By browsing this store or completing a purchase you agree to these Terms of Service. Please read them carefully.</p>
                <h4>1. Who we are</h4>
                <p>This store sells optional in-game cosmetic and utility packages ("virtual items") for the TaxSMP Minecraft server. TaxSMP is an independent community server and is <strong>not affiliated with, endorsed by or associated with Mojang Studios or Microsoft</strong>.</p>
                <h4>2. Purchases &amp; payment</h4>
                <p>All payments are processed securely by <a href="https://www.tebex.io" target="_blank" rel="noopener">Tebex</a>, our authorised payment partner. We never see or store your card details. Prices are shown in the currency set by the store and may change at any time without notice.</p>
                <h4>3. Delivery of virtual items</h4>
                <p>Virtual items are delivered to the Minecraft account (Java username or Bedrock gamertag) you provide at checkout. It is your responsibility to enter the correct account. Items are usually delivered instantly, but delivery may take up to 24 hours. You may need to rejoin the server for items to appear.</p>
                <h4>4. Nature of virtual items</h4>
                <p>Virtual items have no real-world monetary value, cannot be exchanged for cash, and are licensed to you for use on the server — not sold as goods you own. We may modify, replace or remove any item, perk or feature to keep the server balanced and running.</p>
                <h4>5. Conduct</h4>
                <p>Purchasing does not exempt you from the server rules. Access to purchased perks may be suspended without refund if you breach the rules, cheat, or attempt fraudulent chargebacks.</p>
                <h4>6. Changes</h4>
                <p>We may update these terms from time to time. Continued use of the store after changes take effect means you accept the revised terms.</p>
                <h4>7. Contact</h4>
                <p>Questions about your order? Reach us on our <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord server</a>.</p>
            `
        },
        privacy: {
            title: "Privacy Policy",
            body: `
                <p>This Privacy Policy explains what information the TaxSMP store handles and how it is used. We keep data collection to the minimum needed to deliver your purchase.</p>
                <h4>1. Information we handle</h4>
                <ul>
                    <li><strong>Minecraft account</strong> — the Java username or Bedrock gamertag you enter, so items can be delivered to you.</li>
                    <li><strong>Cart &amp; preferences</strong> — stored only in your own browser (local storage) so your basket and account persist between visits.</li>
                    <li><strong>Payment information</strong> — collected and processed entirely by Tebex. We do not receive or store your card or billing details.</li>
                </ul>
                <h4>2. Third-party services</h4>
                <ul>
                    <li><a href="https://www.tebex.io" target="_blank" rel="noopener">Tebex</a> — handles payments and order processing under its own privacy policy.</li>
                    <li><a href="https://geysermc.org" target="_blank" rel="noopener">GeyserMC</a> — used to verify Bedrock gamertags against Xbox so items reach the right account.</li>
                </ul>
                <h4>3. How we use it</h4>
                <p>Information is used solely to process and deliver your order, provide support, and prevent fraud. We do not sell your data or use it for advertising.</p>
                <h4>4. Local storage</h4>
                <p>Your cart, chosen edition and username are saved in your browser's local storage. You can clear them at any time by clearing your browser data.</p>
                <h4>5. Children</h4>
                <p>If you are under the age of 18, please get permission from a parent or guardian before making a purchase.</p>
                <h4>6. Contact</h4>
                <p>For any privacy request, contact us via our <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord server</a>.</p>
            `
        },
        refunds: {
            title: "Refund Policy",
            body: `
                <p>Because purchases unlock digital items that are delivered instantly, all sales are generally considered final. We do, however, want every purchase to be fair.</p>
                <h4>1. Delivery issues</h4>
                <p>If an item you paid for was not delivered, contact us within 7 days on <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord</a> with your order details. We'll investigate and re-deliver or refund where appropriate.</p>
                <h4>2. Accidental or duplicate purchases</h4>
                <p>Contact us as soon as possible. If the item has not yet been used or consumed, we may be able to reverse the purchase at our discretion.</p>
                <h4>3. Chargebacks</h4>
                <p>Please talk to us before opening a payment dispute. Fraudulent chargebacks may result in loss of purchased perks and a server ban.</p>
                <h4>4. How to request</h4>
                <p>All refund requests are handled through our <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord support server</a>. Include your username, the package name, and the approximate date of purchase.</p>
            `
        }
    };

    const openLegal = (key) => {
        const doc = LEGAL[key];
        if (!doc) return;
        $("#legal-title").textContent = doc.title;
        $("#legal-updated").textContent = `Last updated ${LEGAL_UPDATED}`;
        const body = $("#legal-body");
        body.innerHTML = doc.body;
        body.scrollTop = 0;
        $("#legal-modal")?.classList.remove("hidden");
    };
    const closeLegal = () => $("#legal-modal")?.classList.add("hidden");

    const initLegal = () => {
        const yearEl = $("#footer-year");
        if (yearEl) yearEl.textContent = String(new Date().getFullYear());
        $$("[data-legal]").forEach(btn => {
            btn.addEventListener("click", () => openLegal(btn.dataset.legal));
        });
        $$("[data-close-legal]").forEach(el => el.addEventListener("click", closeLegal));
        $("#legal-modal")?.addEventListener("click", (e) => {
            if (e.target === e.currentTarget) closeLegal();
        });
    };

    /* ========== Boot ========== */
    document.addEventListener("DOMContentLoaded", () => {
        initParticles();
        initCopyIp();
        initLegal();
        if (document.body.classList.contains("store-page")) {
            initStore();
        } else {
            initLanding();
        }
    });
})();
