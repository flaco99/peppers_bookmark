// cgpt_bookmark: Mark a spot in a ChatGPT chat, then Jump back to it later.

// ---- Storage ----
// Saves/loads the one bookmark.
// - Uses chrome.storage.local when running as an extension
// - Falls back to localStorage otherwise
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

// Tags that count as "a piece of text you can mark":
// paragraphs, headings, list items, table cells, code blocks,
// block equations, and your own message bubbles.
const BLOCK_SELECTOR =
    "p, h1, h2, h3, h4, h5, h6, li, td, th, pre, [data-d-block], [data-user-message-bubble]";

let CENTER_MSG_EL = null;

// ---- Center message ----

// Returns the pop-up message box shown in the middle of the screen.
// - If it already exists on the page, reuse it
// - Otherwise create it (hidden, centered, dark, non-clickable) and add it to the page
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
    el.style.color = "white";
    el.style.boxShadow = "0 6px 30px rgba(0,0,0,0.35)";
    el.style.backdropFilter = "blur(6px)";
    el.style.maxWidth = "70vw";
    el.style.textAlign = "center";
    el.style.whiteSpace = "pre-wrap";

    el.style.opacity = "0";
    el.style.transition = "opacity 700ms ease";

    document.body.appendChild(el);
    CENTER_MSG_EL = el;
    return el;
}

// Shows a message in the center of the screen, then fades it out.
// - Red background for errors, dark for everything else
// - Resets the fade so repeated messages restart cleanly
// - Fades out after visibleMs milliseconds
function showCenterMessage(text, { type = "info", visibleMs = 1400 } = {}) {
    const el = ensureCenterMessageEl();
    el.textContent = text;
    el.style.background = type === "error" ? "rgba(120, 0, 0, 0.85)" : "rgba(0, 0, 0, 0.85)";

    el.style.transition = "none";
    el.style.opacity = "0";
    void el.offsetWidth; // forces the browser to apply the reset before fading in

    el.style.transition = "opacity 700ms ease";
    el.style.opacity = "1";

    clearTimeout(el._fadeT);
    el._fadeT = setTimeout(() => {
        el.style.opacity = "0";
    }, visibleMs);
}

// ---- DOM helpers ----

// Pauses for the given number of milliseconds (use with await).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Finds the text block (paragraph, heading, bullet, etc.) that contains an element.
// - Walks up from the element to the nearest tag in BLOCK_SELECTOR
// - Returns null if there isn't one
function findPEl(nodeEl) {
    return nodeEl?.closest?.(BLOCK_SELECTOR) || null;
}

// Returns an element's text with all runs of spaces/line breaks collapsed to single spaces.
// Used by both Mark and Jump so they compare text the same way.
function getBlockText(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
}

// Finds the element that actually scrolls the chat.
// - Starts at the conversation and walks up through its parents
// - Returns the first one that can scroll vertically
// - Falls back to the page's main scroller
function getScroller() {
    let el = document.querySelector("[data-thread-find-target='conversation']") || document.body;
    while (el && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
    }
    return document.scrollingElement;
}

// Looks for a text block currently on the page that starts with the given text.
// - Checks every block in order
// - Returns the first match, or null if none
function findTarget(text) {
    const allBlocks = Array.from(document.querySelectorAll(BLOCK_SELECTOR));
    return allBlocks.find((b) => getBlockText(b).startsWith(text)) || null;
}

// Keeps looking for the text until it appears or time runs out.
// - Checks every 0.1 seconds for up to ms milliseconds
// - Returns the block as soon as it's found
// - Does one last check at the end, then returns the result (or null)
async function waitForTarget(text, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const t = findTarget(text);
        if (t) return t;
        await sleep(100);
    }
    return findTarget(text);
}

// Pulls the number out of a turn ID.
// - "fallback-turn-12" becomes 12
// - Returns null if there's no number
function turnNumber(id) {
    const m = /turn-(\d+)/.exec(id || "");
    return m ? parseInt(m[1], 10) : null;
}

// Lists the chat turns (one question or reply each) currently loaded on the page.
// - Each entry has the element and its turn number
// - Turns without a readable number are skipped
// ChatGPT unloads far-away turns, so this is only the nearby ones.
function getLoadedTurns() {
    return Array.from(document.querySelectorAll("[data-content-search-turn-key]"))
        .map((el) => ({ el, n: turnNumber(el.getAttribute("data-content-search-turn-key")) }))
        .filter((t) => t.n !== null);
}

// ---- Mark ----

// Runs when you press Mark. Saves where your selected text is.
// - Checks that you selected something
// - Finds the text block around your selection
// - Saves three clues:
//     1. the first 60 characters of the block
//     2. its turn number
//     3. the current scroll position
// - Shows "Marked", or an error message if something is missing
async function saveMarkFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        showCenterMessage("Select text first, then press Mark.", { type: "error" });
        return;
    }

    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    const pEl = findPEl(node);
    if (!pEl) {
        showCenterMessage("Couldn't find a text block here.", { type: "error" });
        return;
    }

    const blockText = getBlockText(pEl).slice(0, 60);
    if (!blockText) {
        showCenterMessage("That block has no text to remember.", { type: "error" });
        return;
    }

    const turnId = pEl.closest("[data-content-search-turn-key]")?.getAttribute("data-content-search-turn-key") || null;
    const mark = { blockText, turnId, scrollTop: getScroller().scrollTop };

    await storage.set({ [MARK_KEY]: mark });
    showCenterMessage("🐕 Marked", { type: "info" });
}

// ---- Jump ----

// Runs when you press Jump. Scrolls back to the saved spot.
// - Loads the saved mark (error if there isn't one)
// - Step 1: if the text is already on the page, use it
// - Step 2: otherwise, search toward the saved turn and show "Searching…"
//     * Compare the saved turn number with the turns currently loaded
//     * If the saved turn is loaded, scroll to it and wait for its text
//     * If it's outside the loaded range, scroll toward it (up or down) by an
//       estimated distance, then check again (up to 40 tries)
//     * If it's inside the range but missing, stop and use step 3
// - Step 3: fallback, scroll to the saved scroll position and wait for the text
// - If found, smoothly scroll to it and show "Jumped"; otherwise show an error
async function jumpToMark() {
    const data = await storage.get(MARK_KEY);
    const mark = data[MARK_KEY];

    if (!mark || !mark.blockText) {
        showCenterMessage("No mark saved yet.", { type: "error" });
        return;
    }

    const scroller = getScroller();
    const wanted = turnNumber(mark.turnId);

    // Step 1: already on the page?
    let target = findTarget(mark.blockText);

    // Step 2: search toward the saved turn
    if (!target && wanted !== null) {
        showCenterMessage("Searching…", { visibleMs: 8000 });

        for (let i = 0; i < 40 && !target; i++) {
            const turns = getLoadedTurns();
            if (turns.length === 0) { await sleep(150); continue; }

            const exact = turns.find((t) => t.n === wanted);
            if (exact) {
                exact.el.scrollIntoView({ behavior: "instant", block: "center" });
                target = await waitForTarget(mark.blockText, 1000);
                break;
            }

            const min = Math.min(...turns.map((t) => t.n));
            const max = Math.max(...turns.map((t) => t.n));
            if (wanted > min && wanted < max) break; // in range but missing: use step 3

            // Estimate the distance: turns away x average turn height
            // (at least half a screen, at most six screens per hop)
            const avg = turns.reduce((s, t) => s + t.el.offsetHeight, 0) / turns.length || scroller.clientHeight;
            const away = wanted < min ? min - wanted : wanted - max;
            const dist = Math.min(Math.max(away * avg * 0.9, scroller.clientHeight * 0.5), scroller.clientHeight * 6);

            scroller.scrollBy({ top: wanted < min ? -dist : dist, behavior: "instant" });
            await sleep(150);
            target = findTarget(mark.blockText);
        }

        // Step 3: fallback to the saved scroll position
        if (!target && typeof mark.scrollTop === "number") {
            scroller.scrollTo({ top: mark.scrollTop, behavior: "instant" });
            target = await waitForTarget(mark.blockText, 1500);
        }
    }

    if (!target) {
        showCenterMessage("Couldn't find it. Is this the same chat?", { type: "error" });
        return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => showCenterMessage("🐕 Jumped", { type: "info" }), 250);
}

// ---- UI ----

// Adds the Mark and Jump buttons to the bottom right of the page.
// - Does nothing if they're already there
// - Mark runs saveMarkFromSelection, Jump runs jumpToMark
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

    // Builds one green button with the given label.
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

// Starts the extension by adding the buttons to the page.
function init() {
    injectControls();
}

init();