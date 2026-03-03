// bookmark

const storage =
    (typeof chrome !== "undefined" && chrome.storage?.local)
        ? {
            get: (key) => new Promise((res) => chrome.storage.local.get(key, res)),
            set: (obj) => new Promise((res) => chrome.storage.local.set(obj, res)),
        }
        : {
            get: async (key) => {
                const raw = localStorage.getItem(key);
                return { [key]: raw ? JSON.parse(raw) : undefined };
            },
            set: async (obj) => {
                for (const [k, v] of Object.entries(obj)) {
                    localStorage.setItem(k, JSON.stringify(v));
                }
            },
        };

const MARK_KEY = "cgpt_bookmark";

let CENTER_MSG_EL = null;

function ensureCenterMessageEl() {
    if (CENTER_MSG_EL && CENTER_MSG_EL.isConnected) return CENTER_MSG_EL;

    const el = document.createElement("div");
    el.id = "cgpt-center-message";

    el.style.position = "fixed";
    el.style.top = "50%";
    el.style.left = "50%";
    el.style.transform = "translate(-50%, -50%)";
    el.style.zIndex = "999999";
    el.style.pointerEvents = "none";

    el.style.padding = "14px 18px";
    el.style.borderRadius = "8px";
    el.style.fontSize = "16px";
    el.style.fontWeight = "600";
    el.style.background = "rgba(0,0,0,0.85)";
    el.style.color = "white";
    el.style.boxShadow = "0 6px 30px rgba(0,0,0,0.35)";
    el.style.backdropFilter = "blur(6px)";
    el.style.maxWidth = "70vw";
    el.style.textAlign = "center";
    el.style.whiteSpace = "pre-wrap";

    el.style.opacity = "0";
    el.style.transition = "opacity 700ms ease";

    el.innerHTML = `<span id="cgpt-center-message-text"></span>`;

    document.body.appendChild(el);
    CENTER_MSG_EL = el;
    return el;
}

function showCenterMessage(text, { type = "info", visibleMs = 1400 } = {}) {
    const el = ensureCenterMessageEl();
    const t = el.querySelector("#cgpt-center-message-text");
    if (t) t.textContent = text;

    if (type === "error") el.style.background = "rgba(120, 0, 0, 0.85)";
    else el.style.background = "rgba(0, 0, 0, 0.85)";

    el.style.transition = "none";
    el.style.opacity = "0";
    void el.offsetWidth;

    el.style.transition = "opacity 700ms ease";
    el.style.opacity = "1";

    clearTimeout(el._fadeT);
    el._fadeT = setTimeout(() => {
        el.style.opacity = "0";
    }, visibleMs);
}

// ----- DOM helpers
function findMessageEl(nodeEl) {
    return nodeEl?.closest?.("[data-message-id]") || null;
}

function findPEl(nodeEl) {
    return nodeEl?.closest?.("p[data-start][data-end]") || null;
}

function getCharOffsetWithin(elP, range) {
    const pre = document.createRange();
    pre.selectNodeContents(elP);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
}

// ---- Mark + Jump actions
async function saveMarkFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        showCenterMessage("Select text first, then press Mark.", { type: "error" });
        return;
    }

    const range = sel.getRangeAt(0);

    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!(node instanceof Element)) {
        showCenterMessage("Select text inside the chat content.", { type: "error" });
        return;
    }

    const msgEl = findMessageEl(node);
    const pEl = findPEl(node);

    if (!msgEl) {
        showCenterMessage("Couldn't find message container.", { type: "error" });
        return;
    }
    if (!pEl) {
        showCenterMessage("Couldn't find paragraph segment.", { type: "error" });
        return;
    }

    const mark = {
        savedAt: Date.now(),
        messageId: msgEl.getAttribute("data-message-id"),
        pStart: pEl.getAttribute("data-start"),
        pEnd: pEl.getAttribute("data-end"),
        charOffset: getCharOffsetWithin(pEl, range), // still saved for future upgrades
    };

    await storage.set({ [MARK_KEY]: mark });
    console.log("Saved mark:", mark);

    showCenterMessage("🐕 Marked", { type: "info" });
}

async function jumpToMark() {
    const data = await storage.get(MARK_KEY);
    const mark = data[MARK_KEY];

    if (!mark) {
        showCenterMessage("No mark saved yet.", { type: "error" });
        return;
    }

    const msgEl = document.querySelector(
        `[data-message-id="${CSS.escape(mark.messageId)}"]`
    );
    if (!msgEl) {
        showCenterMessage("Message not in DOM. Scroll nearer, then Jump.", { type: "error" });
        return;
    }

    const pEl = msgEl.querySelector(`p[data-start="${CSS.escape(mark.pStart)}"]`);
    if (!pEl) {
        showCenterMessage("Couldn't find paragraph segment.", { type: "error" });
        return;
    }

    pEl.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => showCenterMessage("🐕 Jumped", { type: "info" }), 250);
}

// ---- UI
function injectControls() {
    if (document.getElementById("cgpt-mark-controls")) return;

    const wrap = document.createElement("div");
    wrap.id = "cgpt-mark-controls";
    wrap.style.position = "fixed";
    wrap.style.bottom = "20px";
    wrap.style.right = "20px";
    wrap.style.zIndex = "999999";
    wrap.style.display = "flex";
    wrap.style.gap = "10px";

    function makeBtn(label) {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.padding = "10px 14px";
        b.style.borderRadius = "8px";
        b.style.border = "none";
        b.style.cursor = "pointer";
        b.style.fontSize = "14px";
        b.style.background = "#10a37f";
        b.style.color = "white";
        b.style.boxShadow = "0 2px 10px rgba(0,0,0,0.25)";
        return b;
    }

    const markBtn = makeBtn("Mark");
    markBtn.onclick = () => saveMarkFromSelection().catch(console.error);

    const jumpBtn = makeBtn("Jump");
    jumpBtn.onclick = () => jumpToMark().catch(console.error);

    wrap.appendChild(markBtn);
    wrap.appendChild(jumpBtn);
    document.body.appendChild(wrap);
}

function init() {
    injectControls();
    console.log("Mark/Jump (center message) loaded.");
}

init();