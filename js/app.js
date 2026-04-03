(function () {
  "use strict";

  const STORAGE_EXPENSES = "tripmoney_expenses_v1";
  const STORAGE_CATEGORIES = "tripmoney_categories_v1";

  const DEFAULT_CATEGORIES = [
    "早餐",
    "午餐",
    "晚餐",
    "飲料",
    "點心",
    "交通",
    "購物",
    "娛樂",
    "生鮮",
    "代墊",
  ];

  const CATEGORY_ICON_DIR = "assets/categories/";

  const CAT_ICON_FALLBACK =
    '<svg class="cat-icon cat-icon--fallback" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>';

  function getCategoryIconHtml(categoryName) {
    const n = categoryName && String(categoryName).trim();
    if (n && DEFAULT_CATEGORIES.includes(n)) {
      return (
        '<img class="cat-icon-img" src="' +
        CATEGORY_ICON_DIR +
        encodeURIComponent(n) +
        '.png" alt="" draggable="false" />'
      );
    }
    return CAT_ICON_FALLBACK;
  }

  const CCY_OPTIONS = [
    { code: "EUR", label: "歐元" },
    { code: "JPY", label: "日圓" },
    { code: "USD", label: "美元" },
    { code: "TWD", label: "新台幣" },
  ];

  /** 各幣別相對美元：1 USD = rates[currency] 單位的該幣（與 open.er-api 格式一致） */
  const FALLBACK_USD_RATES = {
    USD: 1,
    EUR: 0.866,
    JPY: 159.43,
    TWD: 32,
  };

  let ratesUsd = null;
  let ledgerMonth = new Date();
  let selectedCategory = DEFAULT_CATEGORIES[0];
  let exprStr = "";
  let videoStream = null;
  let ocrWorker = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatMoney(n) {
    const x = Math.round(n);
    return x.toLocaleString("zh-Hant");
  }

  function loadExpenses() {
    try {
      const raw = localStorage.getItem(STORAGE_EXPENSES);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveExpenses(list) {
    localStorage.setItem(STORAGE_EXPENSES, JSON.stringify(list));
  }

  function expenseSame(x, entry) {
    if (entry.id != null) return x.id === entry.id;
    return (
      x.date === entry.date &&
      (x.category || "") === (entry.category || "") &&
      Number(x.amount) === Number(entry.amount) &&
      (x.note || "") === (entry.note || "")
    );
  }

  function deleteExpenseEntry(entry) {
    if (!window.confirm("確定要刪除這筆花費？")) return;
    const list = loadExpenses();
    const next = list.filter((x) => !expenseSame(x, entry));
    if (next.length === list.length) return;
    saveExpenses(next);
    renderLedger();
  }

  const LEDGER_SWIPE_PX = 72;

  function closeOtherLedgerSwipes(exceptWrap) {
    document.querySelectorAll(".ledger-swipe.is-open").forEach((w) => {
      if (w === exceptWrap) return;
      w.classList.remove("is-open");
      const f = w.querySelector(".ledger-swipe__front");
      if (f) {
        f.style.transition = "transform 0.2s ease";
        f.style.transform = "translateX(0)";
      }
    });
  }

  function bindLedgerSwipe(wrap, front, entry) {
    const SW = LEDGER_SWIPE_PX;
    const delBtn = wrap.querySelector(".ledger-swipe__del");
    let lastTx = 0;
    let touchActive = false;
    let startX = 0;
    let startY = 0;
    let startOffset = 0;
    let lockHoriz = false;

    /** offset 0…SW：向左滑露出的寬度，前景 translateX(-offset) */
    function applyTx(offset, instant) {
      const t = Math.max(0, Math.min(SW, offset));
      lastTx = t;
      front.style.transition = instant ? "none" : "transform 0.2s ease";
      front.style.transform = "translateX(" + -t + "px)";
      if (t >= SW / 2) wrap.classList.add("is-open");
      else wrap.classList.remove("is-open");
    }

    front.addEventListener(
      "touchstart",
      (ev) => {
        touchActive = true;
        startX = ev.touches[0].clientX;
        startY = ev.touches[0].clientY;
        startOffset = wrap.classList.contains("is-open") ? SW : 0;
        lastTx = startOffset;
        lockHoriz = false;
        closeOtherLedgerSwipes(wrap);
        front.style.transition = "none";
      },
      { passive: true }
    );

    front.addEventListener(
      "touchmove",
      (ev) => {
        if (!touchActive) return;
        const x = ev.touches[0].clientX;
        const y = ev.touches[0].clientY;
        const dx = x - startX;
        const dy = y - startY;
        if (!lockHoriz) {
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            lockHoriz = true;
          } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.2) {
            touchActive = false;
            return;
          }
        }
        if (!lockHoriz) return;
        ev.preventDefault();
        applyTx(startOffset - dx, true);
      },
      { passive: false }
    );

    function endTouch() {
      if (!touchActive) return;
      touchActive = false;
      lockHoriz = false;
      applyTx(lastTx > SW / 2 ? SW : 0, false);
    }

    front.addEventListener("touchend", endTouch);
    front.addEventListener("touchcancel", endTouch);

    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteExpenseEntry(entry);
    });
  }

  function loadCategories() {
    try {
      const raw = localStorage.getItem(STORAGE_CATEGORIES);
      if (!raw) return [...DEFAULT_CATEGORIES];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return [...DEFAULT_CATEGORIES];
      const merged = [...DEFAULT_CATEGORIES];
      arr.forEach((c) => {
        if (typeof c === "string" && c.trim() && !merged.includes(c.trim())) merged.push(c.trim());
      });
      return merged;
    } catch {
      return [...DEFAULT_CATEGORIES];
    }
  }

  function saveCategories(list) {
    const custom = list.filter((c) => !DEFAULT_CATEGORIES.includes(c));
    localStorage.setItem(STORAGE_CATEGORIES, JSON.stringify(custom));
  }

  async function fetchRates() {
    const note = $("#rate-note");
    note.textContent = "正在取得匯率…";
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      if (!res.ok) throw new Error("network");
      const data = await res.json();
      if (data.result !== "success" || !data.rates) throw new Error("bad");
      const r = data.rates;
      if (r.USD == null || r.EUR == null || r.JPY == null || r.TWD == null) throw new Error("missing");
      ratesUsd = r;
      note.textContent = "匯率來源：Open ER API（美元基準），僅供參考";
    } catch {
      ratesUsd = { ...FALLBACK_USD_RATES };
      note.textContent = "離線／無法連線，使用內建參考匯率";
    }
  }

  function convertAmount(amount, from, to) {
    if (!ratesUsd || from === to) return amount;
    const r = ratesUsd;
    if (r[from] == null || r[to] == null) return NaN;
    const usd = amount / r[from];
    return usd * r[to];
  }

  function fillCcySelects() {
    const from = $("#ccy-from");
    const to = $("#ccy-to");
    from.innerHTML = "";
    to.innerHTML = "";
    CCY_OPTIONS.forEach((o) => {
      const a = document.createElement("option");
      a.value = o.code;
      a.textContent = o.label;
      from.appendChild(a.cloneNode(true));
      to.appendChild(a.cloneNode(true));
    });
    from.value = "EUR";
    to.value = "TWD";
  }

  function runConvert() {
    const raw = $("#amount-from").value.trim().replace(/,/g, "");
    const num = parseFloat(raw);
    const from = $("#ccy-from").value;
    const to = $("#ccy-to").value;
    if (!raw || Number.isNaN(num)) {
      $("#amount-to").value = "";
      return;
    }
    const out = convertAmount(num, from, to);
    if (!Number.isFinite(out)) {
      $("#amount-to").value = "";
      return;
    }
    if (to === "JPY") {
      $("#amount-to").value = String(Math.round(out));
    } else {
      $("#amount-to").value = out.toFixed(2);
    }
  }

  function swapCcy() {
    const from = $("#ccy-from");
    const to = $("#ccy-to");
    const af = from.value;
    from.value = to.value;
    to.value = af;
    const aFrom = $("#amount-from").value;
    const aTo = $("#amount-to").value;
    $("#amount-from").value = aTo;
    $("#amount-to").value = aFrom;
  }

  async function ensureOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (typeof Tesseract === "undefined") throw new Error("OCR 未載入");
    ocrWorker = await Tesseract.createWorker("eng");
    return ocrWorker;
  }

  async function terminateOcrWorker() {
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
  }

  function extractFirstNumber(text) {
    const m = text.replace(/\s/g, " ").match(/(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,]\d+)?/);
    if (!m) return null;
    let s = m[0].replace(/,/g, "");
    if (s.includes(".") && s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (s.includes(",") && !s.includes(".")) {
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length <= 2) s = parts[0] + "." + parts[1];
      else s = s.replace(/,/g, "");
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  async function startCamera() {
    const wrap = $("#camera-wrap");
    const video = $("#video");
    const status = $("#ocr-status");
    status.textContent = "";
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      video.srcObject = videoStream;
      wrap.classList.remove("hidden");
      $("#btn-camera-start").disabled = true;
      $("#btn-camera-stop").disabled = false;
    } catch (e) {
      status.textContent = "無法開啟相機，請檢查權限或改用 HTTPS／localhost。";
      console.error(e);
    }
  }

  function stopCamera() {
    const video = $("#video");
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      videoStream = null;
    }
    video.srcObject = null;
    $("#camera-wrap").classList.add("hidden");
    $("#btn-camera-start").disabled = false;
    $("#btn-camera-stop").disabled = true;
    $("#ocr-status").textContent = "";
    terminateOcrWorker();
  }

  async function runOcr() {
    const video = $("#video");
    const canvas = $("#canvas-capture");
    const status = $("#ocr-status");
    if (!video.videoWidth) {
      status.textContent = "請先開啟相機並等待畫面";
      return;
    }
    status.textContent = "辨識中…";
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    try {
      const worker = await ensureOcrWorker();
      const {
        data: { text },
      } = await worker.recognize(canvas);
      const n = extractFirstNumber(text);
      if (n != null) {
        $("#amount-from").value = String(n);
        runConvert();
        status.textContent = "已帶入：" + n;
      } else {
        status.textContent = "未偵測到數字，請調整角度或改手動輸入";
      }
    } catch (e) {
      status.textContent = "辨識失敗，請重試";
      console.error(e);
    }
  }

  function setView(name) {
    const rate = $("#view-rate");
    const ledger = $("#view-ledger");
    const fab = $("#fab-add");
    const isRate = name === "rate";
    rate.classList.toggle("hidden", !isRate);
    ledger.classList.toggle("hidden", isRate);
    rate.setAttribute("aria-hidden", String(!isRate));
    ledger.setAttribute("aria-hidden", String(isRate));
    fab.classList.toggle("hidden", isRate);
    document.querySelectorAll(".bottom-nav__item").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.view === name);
    });
    if (!isRate) renderLedger();
  }

  function monthKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
  }

  function formatMonthLabel(d) {
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月";
  }

  function syncLedgerMonthInput() {
    const inp = $("#ledger-month-input");
    if (!inp) return;
    const y = ledgerMonth.getFullYear();
    const m = ledgerMonth.getMonth() + 1;
    inp.value = y + "-" + pad2(m);
    inp.min = "2000-01";
    const cap = new Date();
    inp.max = cap.getFullYear() + 10 + "-12";
  }

  function formatDayHeader(isoDate) {
    const [y, m, day] = isoDate.split("-").map(Number);
    const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(y, m - 1, day).getDay()];
    return y + "/" + m + "/" + day + " 星期" + wd;
  }

  function renderLedger() {
    const label = $("#ledger-month-label");
    label.textContent = formatMonthLabel(ledgerMonth);
    syncLedgerMonthInput();

    const key = monthKey(ledgerMonth);
    const all = loadExpenses().filter((e) => e.date && e.date.startsWith(key));

    const total = all.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    $("#total-spend").textContent = formatMoney(total);

    const byDay = {};
    all.forEach((e) => {
      const d = e.date;
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(e);
    });
    const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

    const list = $("#ledger-list");
    list.innerHTML = "";

    if (days.length === 0) {
      list.innerHTML = '<p class="ledger-empty">本月尚無花費紀錄</p>';
      return;
    }

    days.forEach((day) => {
      const items = byDay[day].sort((a, b) => (b.id || 0) - (a.id || 0));
      const dayTotal = items.reduce((s, e) => s + (Number(e.amount) || 0), 0);

      const section = document.createElement("section");
      section.className = "ledger-day";
      const head = document.createElement("div");
      head.className = "ledger-day__header";
      head.innerHTML =
        "<span>" +
        formatDayHeader(day) +
        '</span><span class="ledger-day__total">$' +
        formatMoney(dayTotal) +
        "</span>";
      section.appendChild(head);

      items.forEach((e) => {
        const wrap = document.createElement("div");
        wrap.className = "ledger-swipe";

        const behind = document.createElement("div");
        behind.className = "ledger-swipe__behind";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "ledger-swipe__del";
        delBtn.textContent = "刪除";
        delBtn.setAttribute("aria-label", "刪除此筆花費");
        behind.appendChild(delBtn);

        const front = document.createElement("div");
        front.className = "ledger-swipe__front ledger-item";
        front.innerHTML =
          '<div class="ledger-item__icon"></div>' +
          '<div class="ledger-item__meta">' +
          '<div class="ledger-item__cat"></div>' +
          '<div class="ledger-item__note"></div>' +
          "</div>" +
          '<div class="ledger-item__amt">$-' +
          formatMoney(e.amount) +
          "</div>";
        front.querySelector(".ledger-item__icon").innerHTML = getCategoryIconHtml(e.category);
        front.querySelector(".ledger-item__cat").textContent = e.category || "";
        front.querySelector(".ledger-item__note").textContent = e.note || "";

        wrap.appendChild(behind);
        wrap.appendChild(front);
        bindLedgerSwipe(wrap, front, e);
        section.appendChild(wrap);
      });

      list.appendChild(section);
    });
  }

  let categories = loadCategories();

  function renderCategories() {
    const box = $("#expense-categories");
    box.innerHTML = "";
    categories.forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cat-chip" + (name === selectedCategory ? " is-selected" : "");
      b.dataset.cat = name;
      b.innerHTML =
        '<span class="cat-chip__circle" aria-hidden="true">' +
        getCategoryIconHtml(name) +
        '</span><span class="cat-chip__label"></span>';
      b.querySelector(".cat-chip__label").textContent = name;
      b.addEventListener("click", () => {
        selectedCategory = name;
        renderCategories();
      });
      box.appendChild(b);
    });
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cat-chip cat-chip--add";
    addBtn.setAttribute("aria-label", "新增分類");
    addBtn.innerHTML =
      '<span class="cat-chip__circle" aria-hidden="true">+</span><span class="cat-chip__label">新增分類</span>';
    addBtn.addEventListener("click", () => {
      const name = window.prompt("請輸入新分類名稱", "");
      if (!name || !name.trim()) return;
      const t = name.trim();
      if (categories.includes(t)) {
        selectedCategory = t;
      } else {
        categories.push(t);
        saveCategories(categories);
        selectedCategory = t;
      }
      renderCategories();
    });
    box.appendChild(addBtn);
  }

  function evaluateExpression(str) {
    const cleaned = str.replace(/\s/g, "");
    if (!cleaned) return NaN;
    if (!/^[\d+\-*/.]+$/.test(cleaned)) return NaN;
    try {
      const v = Function('"use strict"; return (' + cleaned + ")")();
      return typeof v === "number" && Number.isFinite(v) ? v : NaN;
    } catch {
      return NaN;
    }
  }

  function updateAmountDisplay() {
    $("#expense-amount-display").textContent = "$ " + (exprStr || "0");
  }

  function buildKeypad() {
    const grid = $("#keypad");
    grid.innerHTML = "";
    const layout = [
      [{ t: "7", v: "7" }, { t: "8", v: "8" }, { t: "9", v: "9" }, { t: "÷", v: "/" }, { t: "AC", c: "ac", cls: "keypad__fn" }],
      [{ t: "4", v: "4" }, { t: "5", v: "5" }, { t: "6", v: "6" }, { t: "×", v: "*" }, { t: "⌫", c: "bs", cls: "keypad__fn" }],
      [{ t: "1", v: "1" }, { t: "2", v: "2" }, { t: "3", v: "3" }, { t: "+", v: "+" }, { t: "OK", c: "ok", cls: "keypad__ok" }],
      [{ t: "0", v: "0" }, { t: "00", v: "00" }, { t: ".", v: "." }, { t: "−", v: "-" }, null],
    ];

    layout.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        if (cell === null) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = cell.t;
        if (cell.cls) btn.className = cell.cls;
        if (cell.c === "ok") {
          btn.classList.add("keypad__ok");
          btn.style.gridColumn = "5";
          btn.style.gridRow = "3 / 5";
        } else {
          btn.style.gridColumn = String(ci + 1);
          btn.style.gridRow = String(ri + 1);
        }
        btn.addEventListener("click", () => onKeypad(cell));
        grid.appendChild(btn);
      });
    });
  }

  function onKeypad(cell) {
    if (!cell.c) {
      exprStr += cell.v;
      updateAmountDisplay();
      return;
    }
    if (cell.c === "ac") {
      exprStr = "";
      updateAmountDisplay();
      return;
    }
    if (cell.c === "bs") {
      exprStr = exprStr.slice(0, -1);
      updateAmountDisplay();
      return;
    }
    if (cell.c === "ok") {
      const val = evaluateExpression(exprStr.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-"));
      if (Number.isNaN(val) || val <= 0) {
        window.alert("請輸入有效金額");
        return;
      }
      const note = $("#expense-note").value.trim();
      const dateStr = $("#expense-date-input").value;
      const item = {
        id: Date.now(),
        date: dateStr,
        category: selectedCategory,
        amount: Math.round(val * 100) / 100,
        note,
      };
      const list = loadExpenses();
      list.push(item);
      saveExpenses(list);
      const parts = dateStr.split("-");
      if (parts.length === 3) {
        ledgerMonth = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
      }
      closeExpenseOverlay();
      renderLedger();
      return;
    }
  }

  function openExpenseOverlay() {
    exprStr = "";
    $("#expense-note").value = "";
    const today = new Date();
    $("#expense-date-input").value =
      today.getFullYear() + "-" + pad2(today.getMonth() + 1) + "-" + pad2(today.getDate());
    syncExpenseDateLabel();
    updateAmountDisplay();
    selectedCategory = categories[0];
    renderCategories();
    $("#overlay-expense").classList.remove("hidden");
    $("#overlay-expense").setAttribute("aria-hidden", "false");
  }

  function closeExpenseOverlay() {
    $("#overlay-expense").classList.add("hidden");
    $("#overlay-expense").setAttribute("aria-hidden", "true");
  }

  function syncExpenseDateLabel() {
    const v = $("#expense-date-input").value;
    if (!v) return;
    const [y, m, d] = v.split("-").map(Number);
    const today = new Date();
    const isToday =
      y === today.getFullYear() && m === today.getMonth() + 1 && d === today.getDate();
    const label = isToday ? "今日 " : "";
    $("#expense-date-open").textContent = label + y + "/" + pad2(m) + "/" + pad2(d);
  }

  function shiftExpenseDate(delta) {
    const inp = $("#expense-date-input");
    const cur = inp.value;
    if (!cur) return;
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    inp.value =
      dt.getFullYear() + "-" + pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate());
    syncExpenseDateLabel();
  }

  function init() {
    fillCcySelects();
    fetchRates().then(() => runConvert());

    $("#amount-from").addEventListener("input", runConvert);
    $("#ccy-from").addEventListener("change", runConvert);
    $("#ccy-to").addEventListener("change", runConvert);
    $("#btn-convert").addEventListener("click", runConvert);
    $("#btn-swap").addEventListener("click", () => {
      swapCcy();
      runConvert();
    });

    $("#btn-camera-start").addEventListener("click", startCamera);
    $("#btn-camera-stop").addEventListener("click", stopCamera);
    $("#btn-ocr").addEventListener("click", runOcr);

    document.querySelectorAll(".bottom-nav__item").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });

    $("#btn-month-prev").addEventListener("click", () => {
      ledgerMonth = new Date(ledgerMonth.getFullYear(), ledgerMonth.getMonth() - 1, 1);
      renderLedger();
    });
    $("#btn-month-next").addEventListener("click", () => {
      ledgerMonth = new Date(ledgerMonth.getFullYear(), ledgerMonth.getMonth() + 1, 1);
      renderLedger();
    });

    $("#ledger-month-open").addEventListener("click", () => {
      syncLedgerMonthInput();
      const inp = $("#ledger-month-input");
      if (typeof inp.showPicker === "function") inp.showPicker();
      else inp.click();
    });

    $("#ledger-month-input").addEventListener("change", () => {
      const v = $("#ledger-month-input").value;
      if (!v) return;
      const parts = v.split("-");
      if (parts.length < 2) return;
      const y = parseInt(parts[0], 10);
      const mo = parseInt(parts[1], 10);
      if (!y || !mo || mo < 1 || mo > 12) return;
      ledgerMonth = new Date(y, mo - 1, 1);
      renderLedger();
    });

    $("#fab-add").addEventListener("click", openExpenseOverlay);
    $("#expense-close").addEventListener("click", closeExpenseOverlay);

    $("#expense-date-prev").addEventListener("click", () => shiftExpenseDate(-1));
    $("#expense-date-next").addEventListener("click", () => shiftExpenseDate(1));
    $("#expense-date-open").addEventListener("click", () => {
      const inp = $("#expense-date-input");
      if (typeof inp.showPicker === "function") inp.showPicker();
      else inp.click();
    });

    $("#expense-date-input").addEventListener("change", syncExpenseDateLabel);

    buildKeypad();
    categories = loadCategories();
    renderCategories();

    $("#fab-add").classList.add("hidden");
    setView("rate");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
