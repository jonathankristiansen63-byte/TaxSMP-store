(() => {
    "use strict";

    const TEBEX_TOKEN = "12b00-c57914f7265cf8a78648a0126a224d95f4635fde";
    const API = `https://headless.tebex.io/api/accounts/${TEBEX_TOKEN}`;
    const BASKET_API = `https://headless.tebex.io/api/baskets`;
    const WEBSTORE = "https://taxsmp-store.tebex.io";
    const DISCORD_INVITE = "https://discord.gg/3eSTqYaAuR";
    const SERVER_IP = "taxsmp.net";

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const fmt = (n, ccy = "USD") => {
        try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(n); }
        catch { return `$${Number(n).toFixed(2)}`; }
    };
    const compact = (n) => {
        try { return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n); }
        catch { return String(n); }
    };

    // Small JSON GET with a timeout, for the optional status widgets.
    const fetchJSON = async (url, ms = 8000) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try {
            const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally { clearTimeout(timer); }
    };

    // Sale info comes straight from Tebex (base_price vs total_price). A sale
    // is created/scheduled in the Tebex dashboard and enforced server-side at
    // checkout, so it can't be faked or abused from the browser — we only
    // reflect what Tebex reports.
    // Tebex reports a sale by putting the DISCOUNTED price in `base_price` and
    // the amount saved in `discount`, so the original ("was") price is
    // base_price + discount, and the customer now pays total_price.
    const saleInfo = (pkg) => {
        const discount = Number(pkg.discount) || 0;
        const base = Number(pkg.base_price) || 0;
        const now = pkg.total_price != null ? Number(pkg.total_price) : base;
        const was = base + discount;                    // price before the sale
        const onSale = discount > 0.001 && was > now + 0.001;
        return { was, now, onSale, pct: onSale ? Math.round((1 - now / was) * 100) : 0, currency: pkg.currency || "USD" };
    };
    // The price to charge / add to cart (already discounted by Tebex).
    const effectivePrice = (pkg) => saleInfo(pkg).now;
    // Price markup: struck-through original + discounted price when on sale.
    // `qty` scales both so cards can show the total for the chosen quantity.
    const priceHTML = (pkg, qty = 1) => {
        const s = saleInfo(pkg);
        return s.onSale
            ? `<span class="price-was">${fmt(s.was * qty, s.currency)}</span><span class="price-now">${fmt(s.now * qty, s.currency)}</span>`
            : fmt(s.now * qty, s.currency);
    };
    const dealBadge = (pkg) => {
        const s = saleInfo(pkg);
        return s.onSale ? `<span class="deal-badge">🔥 ${s.pct}% off</span>` : "";
    };

    const sanitize = (html) => {
        const div = document.createElement("div");
        // Block-level tags count as line breaks so "<p>a</p><p>b</p>" gives two perks.
        div.innerHTML = (html || "").replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, "$&\n");
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

    // What we SHOW the player. Tebex only accepts the real Xbox gamertag with
    // spaces (".Hero brine8026" — the underscore form 404s), but players
    // recognise their in-game Floodgate name, which uses underscores
    // (".Hero_brine8026"). So the display swaps spaces for underscores while
    // deliveryUsername() keeps the spaces Tebex requires at checkout.
    const displayUsername = () => {
        const name = deliveryUsername();
        if (!name) return name;
        return Store.platform === "bedrock" ? name.replace(/ /g, "_") : name;
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
            placeholder: "e.g. Taxman_MC",
            hint: "3–16 characters. Letters, numbers and underscores only.",
            error: "Java username must be 3–16 letters, numbers or underscores"
        },
        bedrock: {
            // Allow spaces too: some players type their real gamertag ("Hero brine8026")
            // rather than the Floodgate in-game name ("hero_brine8026"). We resolve
            // either form to the canonical gamertag before checkout.
            re: /^[A-Za-z0-9_ ]{3,16}$/,
            pattern: "[A-Za-z0-9_ ]+",
            placeholder: "e.g. .Garnettas",
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

    /* ========== Particles (twinkling stars + drifting fireflies) ========== */
    const initParticles = () => {
        const canvas = $("#particles");
        if (!canvas) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        const ctx = canvas.getContext("2d");
        let particles;
        const COUNT = Math.min(46, Math.floor(window.innerWidth / 28));

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = window.innerWidth * dpr;
            canvas.height = window.innerHeight * dpr;
            canvas.style.width = window.innerWidth + "px";
            canvas.style.height = window.innerHeight + "px";
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
        };
        // Stars sit still and twinkle; fireflies (about a third) wander and pulse
        // gold. Both are drawn as little squares to keep the blocky look.
        const spawn = () => {
            particles = Array.from({ length: COUNT }, () => {
                const firefly = Math.random() < 0.35;
                return {
                    firefly,
                    x: Math.random() * window.innerWidth,
                    y: firefly ? window.innerHeight * (0.35 + Math.random() * 0.65) : Math.random() * window.innerHeight * 0.7,
                    size: firefly ? 3 : Math.random() < 0.3 ? 2.5 : 1.5,
                    phase: Math.random() * Math.PI * 2,
                    speed: 0.02 + Math.random() * 0.03,
                    dir: Math.random() * Math.PI * 2
                };
            });
        };
        const tick = () => {
            ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
            for (const p of particles) {
                p.phase += p.speed;
                const pulse = 0.5 + 0.5 * Math.sin(p.phase);
                if (p.firefly) {
                    p.dir += (Math.random() - 0.5) * 0.15;
                    p.x += Math.cos(p.dir) * 0.35;
                    p.y += Math.sin(p.dir) * 0.25;
                    if (p.x < -10) p.x = window.innerWidth + 10;
                    if (p.x > window.innerWidth + 10) p.x = -10;
                    if (p.y < window.innerHeight * 0.3 || p.y > window.innerHeight + 10) p.dir = -p.dir;
                    ctx.shadowColor = "rgba(255, 200, 80, 0.9)";
                    ctx.shadowBlur = 10;
                    ctx.fillStyle = `rgba(255, 214, 110, ${0.25 + pulse * 0.7})`;
                } else {
                    ctx.shadowBlur = 0;
                    ctx.fillStyle = `rgba(230, 236, 255, ${0.15 + pulse * 0.75})`;
                }
                ctx.fillRect(p.x, p.y, p.size, p.size);
            }
            requestAnimationFrame(tick);
        };
        resize(); spawn(); tick();
        window.addEventListener("resize", () => { resize(); spawn(); });
    };

    /* ========== Copy IP ========== */
    const initCopyIp = () => {
        $$("[data-ip]").forEach(btn => {
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
    // Card colours. Ranks go cheapest → priciest through RANK_TINTS; keys and
    // gems take a rarity colour from their name, else the next palette colour.
    const RANK_TINTS = ["purple", "gold", "blue", "red", "green", "orange"];
    const KEY_TINTS = ["slate", "blue", "purple", "gold", "orange", "green", "red", "teal"];
    const GEM_TINTS = ["teal", "blue", "purple", "gold", "red", "orange"];
    const NAME_TINTS = [
        [/legend|mythic|ultimate|god/i, "gold"],
        [/epic/i, "purple"],
        [/rare/i, "blue"],
        [/spawn/i, "green"],
        [/halloween|pumpkin|fire|lava/i, "orange"],
        [/common|basic|vote|starter/i, "slate"]
    ];
    const tintFor = (pkg, i, palette) =>
        (NAME_TINTS.find(([re]) => re.test(pkg.name || "")) || [])[1] || palette[i % palette.length];

    const QTY_STEPS = [1, 5, 10, 20];

    let storeData = { ranks: [], keys: [], gems: [] };
    const qtySelection = new Map(); // package_id -> selected qty
    let pendingAction = null;       // function to run once username is set

    // Fetch the catalogue with a timeout and a couple of retries. Transient
    // network hiccups get a second chance; a hard block (ad-blocker / strict
    // tracking protection killing the Tebex request) surfaces cleanly to the
    // error card, which links blocked users to the official Tebex store.
    const fetchCategories = async (attempts = 2) => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 12000);
                let res;
                try {
                    res = await fetch(`${API}/categories?includePackages=1`, {
                        headers: { Accept: "application/json" },
                        signal: ctrl.signal
                    });
                } finally { clearTimeout(timer); }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            } catch (err) {
                lastErr = err;
                if (i < attempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
            }
        }
        throw lastErr;
    };

    const productSections = ["#ranks-section", "#crates-section", "#gems-section"];
    const setSectionsVisible = (show) =>
        productSections.forEach(sel => $(sel)?.classList.toggle("hidden", !show));

    const showStoreError = () => {
        setSectionsVisible(false);
        const loading = $("#loading");
        if (!loading) return;
        loading.classList.remove("hidden");
        loading.innerHTML = `
            <div class="store-error">
                <div class="store-error-icon" aria-hidden="true">😕</div>
                <h3>We couldn't load the store</h3>
                <p>This is almost always caused by an <strong>ad-blocker</strong> or a strict browser <strong>privacy / tracking-protection</strong> setting blocking our payment provider (Tebex). Turn it off for this site, then try again.</p>
                <div class="store-error-actions">
                    <button type="button" class="btn-primary" id="store-retry">Try again</button>
                </div>
            </div>`;
        $("#store-retry")?.addEventListener("click", () => loadStore());
    };

    const loadStore = async () => {
        const loading = $("#loading");
        if (loading) {
            loading.classList.remove("hidden");
            loading.innerHTML = `<div class="spinner" aria-hidden="true"></div><p>Loading store…</p>`;
        }
        setSectionsVisible(true);
        try {
            const json = await fetchCategories();
            const cats = (json && json.data) || [];
            const ranks = (cats.find(c => /rank/i.test(c.name))?.packages || [])
                .slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));
            const keys = (cats.find(c => /crate|key/i.test(c.name))?.packages || [])
                .slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));
            const gems = (cats.find(c => /gem|rub(y|ies)|crystal|coin|token|currency/i.test(c.name))?.packages || [])
                .slice().sort((a, b) => (a.base_price || 0) - (b.base_price || 0));
            // A successful response with no packages at all means something
            // upstream is wrong — treat it like a load failure, not an empty store.
            if (!ranks.length && !keys.length && !gems.length) { showStoreError(); return; }
            storeData = { ranks, keys, gems };
            renderRanks();
            renderKeys();
            renderGems();
            setCategoryArt();
            $("#loading")?.classList.add("hidden");
        } catch (err) {
            console.error(err);
            showStoreError();
        }
    };

    const periodLabel = (pkg) => pkg.expiry_period
        ? `per ${pkg.expiry_period.count > 1 ? pkg.expiry_period.count + " " : ""}${pkg.expiry_period.unit}${pkg.expiry_period.count > 1 ? "s" : ""}`
        : "one-time";

    const CHEVRON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

    // One coloured bar per rank (OceanMC-style). The chevron, or a click
    // anywhere on the bar, drops down the full perk list.
    const renderRanks = () => {
        const list = $("#rank-list");
        if (!list) return;

        list.innerHTML = storeData.ranks.map((rank, i) => {
            const perks = sanitize(rank.description);
            const preview = perks.slice(0, 3).map(esc).join(" • ")
                + (perks.length > 3 ? ` • +${perks.length - 3} more` : "");
            return `
                <article class="rank-row tint-${RANK_TINTS[i % RANK_TINTS.length]}" data-rank="${rank.id}">
                    <div class="rank-row-main">
                        <span class="rank-row-icon">${rank.image ? `<img src="${esc(rank.image)}" alt="" loading="lazy" />` : "👑"}</span>
                        <div class="rank-row-title">
                            <h3>${esc(rank.name)} ${dealBadge(rank)}</h3>
                            <span>${periodLabel(rank)}</span>
                        </div>
                        <p class="rank-row-preview">${preview}</p>
                        <div class="rank-row-price">${priceHTML(rank)}</div>
                        <div class="rank-row-actions">
                            <button type="button" class="btn-cart" data-buy>Add to cart</button>
                            ${perks.length ? `<button type="button" class="btn-square" data-perks aria-expanded="false" aria-label="Show ${esc(rank.name)} perks">${CHEVRON}</button>` : ""}
                        </div>
                    </div>
                    ${perks.length ? `
                        <div class="rank-row-perks" aria-hidden="true">
                            <div><ul>${perks.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>
                        </div>` : ""}
                </article>
            `;
        }).join("");

        list.querySelectorAll(".rank-row").forEach(row => {
            const rank = storeData.ranks.find(r => String(r.id) === row.dataset.rank);
            row.querySelector("[data-buy]").addEventListener("click", (e) => {
                e.stopPropagation();
                requestAddToCart(rank, 1);
            });
            const toggle = row.querySelector("[data-perks]");
            if (!toggle) return;
            const flip = () => {
                const open = row.classList.toggle("open");
                toggle.setAttribute("aria-expanded", String(open));
                row.querySelector(".rank-row-perks")?.setAttribute("aria-hidden", String(!open));
            };
            toggle.addEventListener("click", (e) => { e.stopPropagation(); flip(); });
            row.querySelector(".rank-row-main").addEventListener("click", flip);
            row.querySelector(".rank-row-main").style.cursor = "pointer";
        });
    };

    // Each category card shows a random image from its own packages plus a
    // live "4 ranks · from $4.99" pill.
    const setCategoryArt = () => {
        const pick = (arr) => {
            const withImg = (arr || []).filter(p => p.image);
            return withImg.length ? withImg[Math.floor(Math.random() * withImg.length)].image : "";
        };
        const apply = (sel, img) => {
            const el = $(sel);
            if (el && img) el.innerHTML = `<img src="${esc(img)}" alt="" />`;
        };
        apply(".cat-ranks .cat-art", pick(storeData.ranks));
        apply(".cat-crates .cat-art", pick(storeData.keys));
        apply(".cat-gems .cat-art", pick(storeData.gems));

        const meta = (key, noun) => {
            const el = $(`[data-cat-meta="${key}"]`);
            const arr = storeData[key];
            if (!el || !arr.length) return;
            const from = Math.min(...arr.map(effectivePrice));
            el.textContent = `${arr.length} ${noun}${arr.length === 1 ? "" : "s"} · from ${fmt(from, arr[0].currency || "USD")}`;
        };
        meta("ranks", "rank");
        meta("keys", "key");
        meta("gems", "pack");
    };

    const renderKeys = () => buildPackageGrid($("#key-grid"), storeData.keys, KEY_TINTS);

    const renderGems = () => {
        const grid = $("#gem-grid");
        if (!grid) return;
        if (!storeData.gems.length) {
            $("#gems-section")?.classList.add("hidden");
            $("#gems-card")?.classList.add("hidden");
            $("#gems-link")?.classList.add("hidden");
            return;
        }
        buildPackageGrid(grid, storeData.gems, GEM_TINTS, { bestValue: true });
    };

    // "Best value" goes to the pack with the lowest price per unit, read from
    // the number in its name ("1200 Gems"). Needs at least two comparable packs.
    const bestValueId = (packages) => {
        const rated = packages.map(p => {
            const m = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i.exec(p.name || "");
            const amount = m ? parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1) : 0;
            return amount > 0 ? { id: p.id, per: effectivePrice(p) / amount } : null;
        }).filter(Boolean);
        if (rated.length < 2) return null;
        rated.sort((a, b) => a.per - b.per);
        return rated[0].per < rated[1].per ? rated[0].id : null;
    };

    const buildPackageGrid = (grid, packages, palette, { bestValue = false } = {}) => {
        if (!grid) return;
        const bestId = bestValue ? bestValueId(packages) : null;
        grid.innerHTML = packages.map((k, i) => {
            const qty = qtySelection.get(k.id) || 1;
            const step = Math.max(0, QTY_STEPS.indexOf(qty));
            const fixedQty = k.type === "subscription";
            return `
                <article class="key-card tint-${tintFor(k, i, palette)}" data-key="${k.id}">
                    ${dealBadge(k)}
                    ${k.id === bestId ? `<span class="value-badge">★ Best value</span>` : ""}
                    <div class="key-image-wrap">
                        ${k.image ? `<img src="${esc(k.image)}" alt="${esc(k.name)}" loading="lazy" />` : ""}
                    </div>
                    <h3 class="key-name">${esc(k.name)}</h3>
                    ${fixedQty ? "" : `
                        <div class="qty-range">
                            <input type="range" class="qty-slider" min="0" max="${QTY_STEPS.length - 1}" step="1" value="${step}"
                                   aria-label="Quantity" aria-valuetext="${qty}x"
                                   style="--fill:${(step / (QTY_STEPS.length - 1)) * 100}%" />
                            <div class="qty-ticks" aria-hidden="true">
                                ${QTY_STEPS.map((q, s) => `<span class="${s === step ? "on" : ""}" data-step="${s}">${q}x</span>`).join("")}
                            </div>
                        </div>`}
                    <div class="key-price">${priceHTML(k, fixedQty ? 1 : qty)}</div>
                    <button type="button" class="btn-cart" data-add="${k.id}">Add to cart</button>
                </article>
            `;
        }).join("");

        grid.querySelectorAll(".key-card").forEach(card => {
            const id = parseInt(card.dataset.key, 10);
            const pkg = packages.find(k => k.id === id);
            const slider = card.querySelector(".qty-slider");
            const setStep = (s) => {
                const q = QTY_STEPS[s];
                qtySelection.set(id, q);
                slider.value = String(s);
                slider.style.setProperty("--fill", `${(s / (QTY_STEPS.length - 1)) * 100}%`);
                slider.setAttribute("aria-valuetext", `${q}x`);
                card.querySelectorAll(".qty-ticks span").forEach(t => t.classList.toggle("on", Number(t.dataset.step) === s));
                card.querySelector(".key-price").innerHTML = priceHTML(pkg, q);
            };
            if (slider) {
                slider.addEventListener("input", () => setStep(parseInt(slider.value, 10)));
                card.querySelectorAll(".qty-ticks span").forEach(t => {
                    t.addEventListener("click", () => setStep(Number(t.dataset.step)));
                });
            }
            card.querySelector("[data-add]").addEventListener("click", () => {
                const q = qtySelection.get(id) || 1;
                requestAddToCart(pkg, q);
            });
        });
    };

    /* ========== Live counts (players online + Discord) ========== */
    const initServerStatus = async () => {
        const bubble = $("#players-bubble");
        const num = $("#cp-goal-num");
        const pct = $("#cp-goal-pct");
        const fill = $("#cp-bar-fill");
        try {
            const s = await fetchJSON(`https://api.mcsrvstat.us/3/${encodeURIComponent(SERVER_IP)}`);
            if (!s.online || !s.players) {
                if (num) num.textContent = "Server offline";
                return;
            }
            const online = Number(s.players.online) || 0;
            const max = Number(s.players.max) || 0;
            if (bubble) { bubble.textContent = compact(online); bubble.classList.remove("hidden"); }
            if (num) num.textContent = max ? `${online} / ${max} players` : `${online} players`;
            const p = max ? Math.min(100, Math.round((online / max) * 100)) : 0;
            if (pct) pct.textContent = max ? `${p}%` : "";
            // A sliver of bar even at low counts so it never looks empty.
            if (fill) requestAnimationFrame(() => { fill.style.width = `${online ? Math.max(p, 3) : 0}%`; });
        } catch {
            if (num) num.textContent = "Status unavailable";
        }
    };

    const initDiscordCount = async () => {
        const bubble = $("#discord-bubble");
        if (!bubble) return;
        try {
            const code = DISCORD_INVITE.split("/").pop();
            const d = await fetchJSON(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`);
            const n = d.approximate_presence_count || d.approximate_member_count;
            if (n) { bubble.textContent = compact(n); bubble.classList.remove("hidden"); }
        } catch { /* bubble just stays hidden */ }
    };

    /* ========== Sticky bar: highlight the section in view ========== */
    const initStoreBar = () => {
        const links = $$("#bar-links .bar-link");
        if (!links.length) return;
        let queued = false;
        const update = () => {
            queued = false;
            let current = "top";
            const line = window.innerHeight * 0.4;
            for (const a of links) {
                const target = document.getElementById(a.dataset.spy);
                if (!target || a.dataset.spy === "top" || target.classList.contains("hidden")) continue;
                if (target.getBoundingClientRect().top <= line) current = a.dataset.spy;
            }
            links.forEach(a => a.classList.toggle("active", a.dataset.spy === current));
        };
        window.addEventListener("scroll", () => {
            if (!queued) { queued = true; requestAnimationFrame(update); }
        }, { passive: true });
        update();
    };

    /* ========== Cart ========== */
    const updateCartBadge = () => {
        const badge = $("#cart-count");
        if (!badge) return;
        const cart = Store.cart;
        const total = cart.reduce((s, i) => s + i.quantity, 0);
        badge.textContent = total;
        const totalEl = $("#cart-total");
        if (totalEl) totalEl.textContent = fmt(cart.reduce((s, i) => s + i.price * i.quantity, 0), cart[0]?.currency || "USD");
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
                price: effectivePrice(pkg),
                currency: pkg.currency || "USD",
                image: pkg.image || "",
                type: pkg.type || "single",
                quantity: pkg.type === "subscription" ? 1 : quantity
            });
        }
        Store.cart = cart;
        updateCartBadge();
        flashAdded(pkg.id);
    };

    // Quiet confirmation instead of a toast: the clicked package's button
    // turns into "✓ Added" for a moment and the cart button pops. The shopper
    // stays on the store and opens the cart themselves.
    const flashAdded = (id) => {
        $$(`.key-card[data-key="${id}"] [data-add], .rank-row[data-rank="${id}"] [data-buy]`).forEach(btn => {
            if (!btn.dataset.label) btn.dataset.label = btn.textContent;
            btn.textContent = "✓ Added";
            btn.classList.add("added");
            clearTimeout(btn._addedTimer);
            btn._addedTimer = setTimeout(() => {
                btn.textContent = btn.dataset.label;
                btn.classList.remove("added");
            }, 1400);
        });
        const cartBtn = $("#cart-btn");
        if (cartBtn) {
            cartBtn.classList.remove("pop");
            void cartBtn.offsetWidth;
            cartBtn.classList.add("pop");
        }
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
    const skinHeadUrl = (name, size = 40) => `https://mc-heads.net/avatar/${encodeURIComponent(name || "Steve")}/${size}`;

    const USER_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z"/></svg>`;
    const TRASH_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>`;

    // The three "Complete purchase" boxes must all be ticked before checkout.
    const agreeBoxes = () => $$("#co-checks [data-agree]");
    const allAgreed = () => agreeBoxes().every(b => b.checked);
    const updateAgreeState = () => $("#checkout-btn")?.classList.toggle("not-ready", !allAgreed());

    const renderCart = () => {
        const rowsEl = $("#checkout-rows");
        const tableEl = $("#checkout-table");
        const emptyEl = $("#checkout-empty");
        const ctaEl = $("#checkout-cta");
        const totalEl = $("#checkout-total");
        if (!rowsEl) return;
        const cart = Store.cart;
        const ccy = cart[0]?.currency || "USD";
        const display = displayUsername() || "Not signed in";
        const verify = $("#co-verify-name");
        if (verify) verify.textContent = display;

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
                    ${it.image ? `<img class="co-icon" src="${esc(it.image)}" alt="" />` : ""}
                    <span>${esc(it.name)}</span>
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
                </div>
                <div class="co-end">
                    <button type="button" class="co-user" data-user title="Delivered to this account (click to change)">
                        ${USER_ICON}<span>${esc(display)}</span>
                    </button>
                    <button type="button" class="row-btn row-remove" data-remove aria-label="Remove ${esc(it.name)}">${TRASH_ICON}</button>
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
            row.querySelector("[data-user]")?.addEventListener("click", () => showUserModal());
        });

        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        totalEl.textContent = fmt(total, ccy);
        updateAgreeState();
    };

    // Checkout is shown in place of the store, under the header. It gets its
    // own #checkout history entry so the browser Back button returns to the
    // store, and the store's scroll position is restored on the way back.
    let storeScroll = 0;
    const showCheckout = () => {
        if (!document.body.classList.contains("checkout-open")) storeScroll = window.scrollY;
        renderCart();
        $("#checkout-screen")?.classList.remove("hidden");
        document.body.classList.add("checkout-open");
        window.scrollTo({ top: 0, behavior: "instant" });
    };
    const hideCheckout = () => {
        if (!document.body.classList.contains("checkout-open")) return;
        $("#checkout-screen")?.classList.add("hidden");
        document.body.classList.remove("checkout-open");
        window.scrollTo({ top: storeScroll, behavior: "instant" });
    };
    const openCart = () => {
        if (location.hash !== "#checkout") history.pushState({ checkout: true }, "", "#checkout");
        showCheckout();
    };
    const closeCart = () => {
        if (!document.body.classList.contains("checkout-open")) return;
        hideCheckout();
        if (history.state?.checkout) history.back();
        else if (location.hash === "#checkout") history.replaceState(null, "", location.pathname + location.search);
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
            // Pre-fill the editable name in the same underscore form we display.
            input.value = Store.user
                ? (Store.platform === "bedrock" ? Store.user.replace(/ /g, "_") : Store.user)
                : "";
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

    // Reflect the current player in the store bar chip and the account panel.
    const updateAccountUI = () => {
        const u = Store.user;
        const name = u ? displayUsername() : "";
        [["#bar-user-head", 40], ["#cp-head", 80]].forEach(([sel, size]) => {
            const img = $(sel);
            if (!img) return;
            img.onerror = () => { img.onerror = null; img.src = skinHeadUrl("Steve", size); };
            img.src = u ? skinHeadUrl(u, size) : "assets/favicon.png";
        });
        const set = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
        set("#bar-user-name", u ? name : "Log in");
        set("#cp-name", u ? name : "Not logged in");
        set("#cp-sub", u
            ? `${Store.platform === "bedrock" ? "Bedrock" : "Java"} Edition — purchases are delivered to this account.`
            : "Log in with your Minecraft name to start shopping.");
        set("#cp-login", u ? "Change account" : "Log in");
    };

    /* ========== Checkout ========== */
    // Tebex.js (loaded from js.tebex.io) shows the payment step as a popup
    // over our page. If it was blocked we fall back to Tebex's full-page checkout.
    const TEBEX_COLORS = [{ name: "primary", color: "#ffb11f" }];
    let tebexBound = false;
    let tebexPaid = false;

    const resetCheckoutBtn = () => {
        const btn = $("#checkout-btn");
        const label = $("#checkout-label");
        if (btn) btn.disabled = false;
        if (label) label.textContent = "Checkout";
    };

    const bindTebexEvents = (tebex) => {
        if (tebexBound) return;
        tebexBound = true;
        // Celebrate once the payment is done AND the popup is gone, whichever
        // of the two events Tebex sends first.
        const finishPaid = () => {
            tebexPaid = false;
            closeCart();
            celebrate();
        };
        tebex.on("payment:complete", () => {
            tebexPaid = true;
            Store.cart = [];
            updateCartBadge();
            renderCart();
            if (!tebex.isOpen) finishPaid();
        });
        tebex.on("close", () => {
            resetCheckoutBtn();
            if (tebexPaid) finishPaid();
        });
    };

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
        if (!allAgreed()) {
            toast("Please tick all three boxes to continue", true);
            const checks = $("#co-checks");
            if (checks) { checks.classList.remove("shake"); void checks.offsetWidth; checks.classList.add("shake"); }
            return;
        }

        btn.disabled = true;
        try {
            // For Bedrock, turn the typed in-game name into the real Xbox gamertag
            // Tebex can resolve. Java names pass straight through.
            label.textContent = Store.platform === "bedrock" ? "Finding your account…" : "Building basket…";
            const tebexUsername = await resolveTebexUsername(Store.user, Store.platform);
            if (!tebexUsername) {
                throw new Error(`We couldn't find "${displayUsername()}" as a Bedrock player. Double-check your in-game name and try again.`);
            }

            label.textContent = "Building basket…";
            // Tebex only accepts http(s) URLs. Fall back to the webstore when running from file://
            const proto = window.location.protocol;
            const onWeb = proto === "http:" || proto === "https:";
            const base = onWeb ? (window.location.origin + window.location.pathname) : WEBSTORE;
            // Checkout goes DIRECT to Tebex only — never through a relay — so the
            // payment/redirect path can't be tampered with by a third party.
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
                    throw new Error(`We couldn't find "${displayUsername()}" as a ${Store.platform === "bedrock" ? "Bedrock" : "Java"} player. Check the Java/Bedrock toggle matches your edition and try again.`);
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

            const tebex = window.Tebex?.checkout;
            if (tebex) {
                try {
                    label.textContent = "Opening checkout…";
                    bindTebexEvents(tebex);
                    tebex.init({
                        ident,
                        theme: "dark",
                        colors: TEBEX_COLORS,
                        popupOnMobile: true,
                        closeOnEsc: true,
                        closeOnPaymentComplete: true
                    });
                    await tebex.launch();
                    return; // the popup's "close" event re-enables the button
                } catch (popupErr) {
                    console.error(popupErr); // fall through to the full-page checkout
                }
            }

            label.textContent = "Redirecting…";
            Store.cart = [];
            window.location.assign(checkoutUrl);
        } catch (err) {
            console.error(err);
            // A TypeError with no HTTP status means the request never left the
            // browser — a privacy/ad-block extension is blocking secure checkout.
            // Send them to the official Tebex store (a first-party page those
            // blockers allow) so they can still buy safely.
            if (err instanceof TypeError) {
                toast("Your browser is blocking secure checkout. Opening our official Tebex store…", true);
                setTimeout(() => window.open(WEBSTORE, "_blank", "noopener"), 1200);
            } else {
                toast(err.message || "Checkout failed. Try again.", true);
            }
            resetCheckoutBtn();
        }
    };

    /* ========== Purchase celebration ========== */
    const launchConfetti = () => {
        const canvas = $("#confetti");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = () => window.innerWidth, H = () => window.innerHeight;
        canvas.width = W() * dpr; canvas.height = H() * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const colors = ["#ffc233", "#f59e0b", "#22d39a", "#ff5571", "#5865F2", "#ffffff"];
        const N = Math.min(200, Math.floor(W() / 6));
        const pieces = Array.from({ length: N }, () => ({
            x: Math.random() * W(),
            y: -20 - Math.random() * H() * 0.6,
            w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
            vx: (Math.random() - 0.5) * 2.4, vy: 2 + Math.random() * 3.6,
            rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.32,
            color: colors[Math.floor(Math.random() * colors.length)]
        }));
        const start = performance.now();
        const tick = (t) => {
            ctx.clearRect(0, 0, W(), H());
            let alive = false;
            for (const p of pieces) {
                p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.rot += p.vr;
                if (p.y < H() + 30) alive = true;
                ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
                ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            }
            if (alive && t - start < 6500) requestAnimationFrame(tick);
            else ctx.clearRect(0, 0, W(), H());
        };
        requestAnimationFrame(tick);
    };
    const celebrate = () => {
        const el = $("#celebrate");
        if (!el) return;
        el.classList.remove("hidden");
        launchConfetti();
    };
    const closeCelebrate = () => $("#celebrate")?.classList.add("hidden");

    /* ========== Store init ========== */
    const initStore = () => {
        loadStore();
        updateCartBadge();
        updateAccountUI();
        initStoreBar();
        initServerStatus();
        initDiscordCount();

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
            let val = $("#user-input").value.trim().replace(/\s+/g, " ");
            // Players often paste their Bedrock name with the dot prefix; we add
            // that ourselves, so strip any leading dot before validating.
            if (modalPlatform === "bedrock") val = val.replace(/^\.+\s*/, "");
            if (!rules.re.test(val)) {
                toast(rules.error, true);
                return;
            }

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
                Store.user = resolved.gamertag; // real gamertag WITH spaces — Tebex needs this
                Store.xuid = resolved.xuid;
            } else {
                Store.platform = "java";
                Store.user = val;
                Store.xuid = "";
            }
            updateAccountUI();
            const ownBox = $('#co-checks [data-agree="account"]');
            if (ownBox) ownBox.checked = false; // they must re-confirm the new account
            renderCart(); // keep the checkout rows in sync
            $("#user-modal").classList.add("hidden");
            // Resume whatever the user was trying to do
            const action = pendingAction;
            pendingAction = null;
            if (action) setTimeout(action, 100);
        });

        $("#bar-user")?.addEventListener("click", () => showUserModal());
        $("#cp-login")?.addEventListener("click", () => showUserModal());
        agreeBoxes().forEach(box => box.addEventListener("change", updateAgreeState));
        window.addEventListener("popstate", () => (location.hash === "#checkout" ? showCheckout() : hideCheckout()));
        if (location.hash === "#checkout") showCheckout();

        $("#checkout-btn")?.addEventListener("click", doCheckout);
        $("#celebrate-close")?.addEventListener("click", closeCelebrate);
        $("#celebrate")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeCelebrate(); });

        // Escape closes the top-most layer only.
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            const open = (sel) => !$(sel)?.classList.contains("hidden");
            if (open("#legal-modal")) closeLegal();
            else if (open("#user-modal")) hideUserModal();
            else if (open("#celebrate")) closeCelebrate();
            else closeCart();
        });

        // Status from Tebex return
        const params = new URLSearchParams(window.location.search);
        if (params.get("status") === "complete") {
            celebrate();
            history.replaceState({}, "", window.location.pathname);
        } else if (params.get("status") === "cancel") {
            toast("Payment cancelled.", true);
            history.replaceState({}, "", window.location.pathname);
        }
    };

    /* ========== Legal (Terms / Privacy / Refunds) ========== */
    const LEGAL_UPDATED = "26 October 2026";
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
                <p>Virtual items are delivered automatically to the Minecraft account (Java username or Bedrock gamertag) you provide at checkout, so please make sure it is correct. Delivery is usually instant but can take up to 24 hours, and you may need to rejoin the server for items to appear. <strong>If you don't receive your items, open a ticket in our <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord</a> and a staff member will deliver them to you manually.</strong></p>
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
                    <li><a href="https://mc-heads.net" target="_blank" rel="noopener">mc-heads.net</a> — shows your Minecraft skin head next to your name.</li>
                    <li><a href="https://mcsrvstat.us" target="_blank" rel="noopener">mcsrvstat.us</a> and <a href="https://discord.com" target="_blank" rel="noopener">Discord</a> — used to show how many players and community members are online. Only our server address and invite code are sent.</li>
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
        delivery: {
            title: "Delivery & Missing Items",
            body: `
                <p>Every purchase is delivered <strong>automatically</strong> to the account you enter at checkout — there's nothing else you need to do.</p>
                <h4>When you'll get your items</h4>
                <p>Delivery is usually instant. During busy periods, or if you're offline at the time, it can take up to 24 hours. You may need to rejoin the server for ranks, keys or gems to show up.</p>
                <h4>Didn't receive something?</h4>
                <p>If an item you paid for hasn't arrived, don't worry — open a ticket in our <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord</a> with your username and what you bought, and a staff member will deliver it to you manually.</p>
                <h4>A note on refunds</h4>
                <p>Because items are digital and delivered instantly, we don't offer cash refunds — but we will always make sure you actually receive what you paid for. Just reach out on Discord and we'll sort it out.</p>
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
