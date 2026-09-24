/* Perekup Radar — Telegram Mini App без своего сервера.
 *
 * Откуда данные:
 *   - настройки подписчика бот кладёт в адрес кнопки: #s=j.<base64 JSON> или
 *     #s=z.<base64 deflate> (см. webapp_state.py). Хэш не уходит на сервер;
 *   - справочники городов и категорий — статические файлы data/*.json
 *     (их выгружает tools/export_webapp.py из справочников бота).
 * Куда уходят изменения:
 *   - Telegram.WebApp.sendData(JSON одной операции), до 4096 байт. После этого
 *     Telegram закрывает приложение, а бот отвечает в чате. Бот проверяет всё
 *     заново (webapp_ops.py) — здесь проверка только для удобства человека.
 * Без Telegram (обычный браузер) — демо: пример данных и показ операции.
 */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  var inTelegram = !!(tg && tg.initData);

  var SOURCES = { olx: "🟠 OLX", kaspi: "🔴 Kaspi" };
  var QUICK_PRICES = [100000, 300000, 500000, 1000000];
  var MAX_DATA = 4096;
  var MAX_WORD = 40;

  var i18n = null;      // {ru: {...}, kk: {...}}
  var dirs = null;      // справочники
  var state = null;     // состояние от бота
  var lang = "ru";
  var stack = [];       // экраны: {name, ...}
  var mainAction = null;

  var app = document.getElementById("app");

  // ------------------------------------------------------------ тексты

  function T(key, params) {
    var text = (i18n && (i18n[lang][key] || i18n.ru[key])) || key;
    Object.keys(params || {}).forEach(function (name) {
      text = text.split("{" + name + "}").join(String(params[name]));
    });
    return text;
  }

  function number(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  function priceText(from, to) {
    if (from == null && to == null) return T("price_any");
    if (from != null && to != null) return number(from) + " – " + number(to) + " ₸";
    if (from != null) return T("price_from_value", { n: number(from) });
    return T("price_to_value", { n: number(to) });
  }

  function quickLabel(n) {
    return n >= 1000000 ? T("price_upto_m", { n: n / 1000000 }) : T("price_upto_k", { n: n / 1000 });
  }

  function dateText(unix) {
    var d = new Date(unix * 1000);
    function two(x) { return (x < 10 ? "0" : "") + x; }
    return two(d.getDate()) + "." + two(d.getMonth() + 1) + "." + d.getFullYear();
  }

  function timeText(minutes) {
    function two(x) { return (x < 10 ? "0" : "") + x; }
    return two(Math.floor(minutes / 60)) + ":" + two(minutes % 60);
  }

  // ------------------------------------------------------------ DOM

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value == null || value === false) return;
      if (key === "text") el.textContent = value;
      else if (key === "class") el.className = value;
      else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) el.appendChild(c); });
      else el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  function sectionTitle(text) { return h("div", { class: "section-title", text: text }); }

  function row(label, value, onclick, extra) {
    return h(onclick ? "button" : "div", { class: "row" + (extra || ""), type: onclick ? "button" : null, onclick: onclick },
      h("span", { class: "grow", text: label }),
      value != null ? h("span", { class: "value", text: value }) : null,
      onclick ? h("span", { class: "chevron", text: "›" }) : null);
  }

  // ------------------------------------------------------------ кнопки Telegram

  function setMain(text, action, enabled) {
    mainAction = action;
    var on = enabled !== false;
    if (inTelegram) {
      tg.MainButton.setText(text);
      if (on) tg.MainButton.enable(); else tg.MainButton.disable();
      tg.MainButton.show();
    } else {
      var button = document.getElementById("bottom-button");
      button.textContent = text;
      button.disabled = !on;
      document.getElementById("bottom").hidden = false;
    }
  }

  function hideMain() {
    mainAction = null;
    if (inTelegram) tg.MainButton.hide();
    else document.getElementById("bottom").hidden = true;
  }

  function updateBack() {
    if (!inTelegram) return;
    if (stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
  }

  function confirmAsk(text, then) {
    if (inTelegram && tg.showConfirm) tg.showConfirm(text, function (ok) { if (ok) then(); });
    else if (window.confirm(text)) then();
  }

  function haptic(kind) {
    try { if (inTelegram && tg.HapticFeedback) tg.HapticFeedback.selectionChanged(kind); } catch (e) { /* старый клиент */ }
  }

  // ------------------------------------------------------------ навигация

  function push(screen) { stack.push(screen); render(); window.scrollTo(0, 0); }
  function pop() { if (stack.length > 1) { stack.pop(); render(); } }
  function top() { return stack[stack.length - 1]; }

  function render() {
    var screen = top();
    // язык из настроек применяется только после сохранения; на других экранах — язык бота
    if (screen.name !== "settings") lang = i18n[state.l] ? state.l : "ru";
    app.innerHTML = "";
    hideMain();
    updateBack();
    if (!inTelegram && stack.length > 1) {
      // вне Telegram нет его кнопки «Назад» — рисуем свою
      app.appendChild(h("button", { class: "button link", type: "button", onclick: pop }, "← " + T("back")));
    }
    ({ list: renderList, editor: renderEditor, city: renderCity, category: renderCategory,
       settings: renderSettings })[screen.name](screen);
  }

  // ------------------------------------------------------------ отправка боту

  function send(op) {
    var text = JSON.stringify(op);
    if (new TextEncoder().encode(text).length > MAX_DATA) {
      showError(T("err_too_big"));
      return;
    }
    haptic();
    if (inTelegram) {
      tg.sendData(text);          // Telegram закроет приложение, бот ответит в чате
      return;
    }
    document.getElementById("demo-title").textContent = T("demo_sent");
    document.getElementById("demo-out").textContent = JSON.stringify(op, null, 2);
    document.getElementById("demo-close").textContent = T("close");
    var dialog = document.getElementById("demo-dialog");
    if (dialog.showModal) dialog.showModal(); else window.alert(text);
  }

  function showError(text) {
    var old = app.querySelector(".error.global");
    if (old) old.remove();
    app.appendChild(h("p", { class: "error global", text: text }));
    if (inTelegram && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
  }

  // ------------------------------------------------------------ справочники

  function cityName(source, key) {
    if (!key) return T("city_all");
    var city = dirs.cities[source] && dirs.cities[source].byKey[key];
    return city ? city.n : key;
  }

  function categoryName(key) {
    if (!key) return T("category_all");
    var names = [];
    for (var k = key; k; k = dirs.categories.byKey[k] ? dirs.categories.byKey[k].p : "") {
      var node = dirs.categories.byKey[k];
      if (!node) { names.unshift(k); break; }
      names.unshift(node.n);
    }
    return names.join(" → ");
  }

  function prepareDirs(olx, kaspi, cats) {
    function cities(raw) {
      var byKey = {};
      var items = raw.items.map(function (x) { var c = { k: x[0], n: x[1], r: x[2] || "" }; byKey[c.k] = c; return c; });
      return { items: items, byKey: byKey, top: raw.top.filter(function (k) { return byKey[k]; }) };
    }
    var byKey = {}, children = { "": [] };
    cats.items.forEach(function (x) {
      var key = x[0], parent = key.indexOf("/") >= 0 ? key.slice(0, key.lastIndexOf("/")) : "";
      byKey[key] = { k: key, n: x[1], p: parent };
      (children[parent] = children[parent] || []).push(key);
    });
    return { cities: { olx: cities(olx), kaspi: cities(kaspi) }, categories: { byKey: byKey, children: children } };
  }

  // ------------------------------------------------------------ список

  function daysLeft(until) { return Math.max(0, Math.ceil((until * 1000 - Date.now()) / 86400000)); }

  function renderList() {
    var subs = state.subs;
    var count = state.cut || subs.length;     // cut — подписки не влезли в адрес
    var full = count >= state.lim;

    app.appendChild(h("h1", { text: T("app_title") }));

    var active = state.u > Date.now() / 1000;
    var status = active
      ? h("div", { class: "status", text: T("access_until", { date: dateText(state.u), days: daysLeft(state.u) }) })
      : h("div", { class: "status closed", text: T(state.pay ? "access_closed" : "access_closed_nopay") });
    app.appendChild(h("div", { class: "section" }, status));

    if (state.pay) {
      // оплата — в чате: приложение закрывается, бот присылает тарифы
      app.appendChild(h("div", { style: "margin-top:12px" },
        h("button", { class: "button" + (active ? "" : " primary"), type: "button",
                      onclick: function () { send({ v: 1, op: "pay" }); } },
          T(active ? "extend_btn" : "pay_btn"))));
    }

    app.appendChild(sectionTitle(T("subs_title", { count: count, limit: state.lim })));

    if (state.cut) {
      app.appendChild(h("div", { class: "section" }, h("div", { class: "status", text: T("cut_note") })));
    } else if (!subs.length) {
      app.appendChild(h("div", { class: "section" }, h("div", { class: "status", text: T("no_subs") })));
    } else {
      app.appendChild(h("div", { class: "section" }, subs.map(subCard)));
    }

    app.appendChild(h("div", { style: "margin-top:12px" },
      h("button", { class: "button primary", type: "button", disabled: full,
                    onclick: function () { openEditor(null); } }, T("add_sub"))));

    if (full) {
      app.appendChild(h("p", { class: "note", text: T("limit_note", { count: count, limit: state.lim }) }));
    }

    app.appendChild(sectionTitle(T("settings")));
    app.appendChild(h("div", { class: "section" },
      row(T("language"), T("lang_name"), function () { openSettings(); }),
      row(T("quiet"), quietSummary(state.q), function () { openSettings(); })));

    app.appendChild(h("p", { class: "note", text: T("chat_hint") }));
  }

  function subCard(sub) {
    var paused = !!sub.p;
    var meta = [cityName(sub.s, sub.c)];
    if (sub.s === "kaspi") meta.push(categoryName(sub.k));

    if (sub.ro) {
      return h("div", { class: "card" + (paused ? " paused" : "") },
        h("div", { class: "top" }, h("span", { text: SOURCES[sub.s] || sub.s }),
          paused ? h("span", { class: "badge", text: T("paused_badge") }) : null),
        h("div", { class: "words", text: (sub.w || []).join(", ") + " …" }),
        h("div", { class: "meta", text: T("ro_note") }),
        h("div", { class: "actions" },
          h("button", { class: "button small", type: "button",
                        onclick: function () { send({ v: 1, op: "pause", i: sub.i, p: paused ? 0 : 1 }); } },
            paused ? T("btn_resume") : T("btn_pause")),
          h("button", { class: "button small", type: "button",
                        onclick: function () { confirmAsk(T("confirm_delete"), function () { send({ v: 1, op: "delete", i: sub.i }); }); } },
            T("btn_delete"))));
    }

    return h("button", { class: "row card" + (paused ? " paused" : ""), type: "button", onclick: function () { openEditor(sub); } },
      h("span", { class: "grow" },
        h("div", { class: "top" }, h("span", { text: SOURCES[sub.s] || sub.s }),
          paused ? h("span", { class: "badge", text: T("paused_badge") }) : null),
        h("div", { class: "words", text: sub.w.join(", ") }),
        h("div", { class: "meta", text: meta.join(" · ") + " · " + priceText(sub.f, sub.t) }),
        sub.x.length ? h("div", { class: "minus meta", text: "🚫 " + sub.x.join(", ") }) : null),
      h("span", { class: "chevron", text: "›" }));
  }

  function quietSummary(q) {
    if (!q) return T("quiet_off");
    return timeText(q[0]) + "–" + timeText(q[1]) + ", " + T(q[2] === "hold" ? "mode_hold_short" : "mode_silent_short");
  }

  // ------------------------------------------------------------ редактор

  function openEditor(sub) {
    var draft = sub
      ? { i: sub.i, r: sub.r, s: sub.s, c: sub.c, k: sub.k, w: sub.w.slice(), x: sub.x.slice(), f: sub.f, t: sub.t, p: sub.p }
      : { i: null, r: null, s: state.src[0], c: "", k: "", w: [], x: [], f: null, t: null, p: 0 };
    push({ name: "editor", draft: draft });
  }

  function renderEditor(screen) {
    var d = screen.draft;
    var isNew = d.i == null;

    app.appendChild(h("h1", { text: isNew ? T("new_sub") : T("edit_sub") }));

    if (isNew && state.src.length > 1) {
      app.appendChild(sectionTitle(T("source")));
      app.appendChild(h("div", { class: "section" }, h("div", { class: "segmented" },
        state.src.map(function (s) {
          return h("button", { type: "button", class: d.s === s ? "on" : "",
            onclick: function () { if (d.s !== s) { d.s = s; d.c = ""; d.k = ""; render(); } } }, SOURCES[s] || s);
        }))));
    } else {
      app.appendChild(sectionTitle(T("source")));
      app.appendChild(h("div", { class: "section" }, row(SOURCES[d.s] || d.s, null, null)));
    }

    app.appendChild(sectionTitle(T("where")));
    var where = [row(T("city"), cityName(d.s, d.c), function () { push({ name: "city", draft: d, query: "" }); })];
    if (d.s === "kaspi") {
      where.push(row(T("category"), categoryName(d.k), function () { push({ name: "category", draft: d, parent: parentOf(d.k) }); }));
    }
    app.appendChild(h("div", { class: "section" }, where));

    app.appendChild(sectionTitle(T("words")));
    app.appendChild(h("div", { class: "section" }, h("div", { class: "field" },
      chipsField(d.w, state.mw, "", function () { validate(); }))));
    app.appendChild(h("p", { class: "note", text: T("words_hint", { max: state.mw }) }));

    app.appendChild(sectionTitle(T("minus")));
    app.appendChild(h("div", { class: "section" }, h("div", { class: "field" },
      chipsField(d.x, state.mx, " minus", function () { validate(); }))));
    app.appendChild(h("p", { class: "note", text: T("minus_hint", { max: state.mx }) }));

    app.appendChild(sectionTitle(T("price")));
    app.appendChild(h("div", { class: "section" }, h("div", { class: "field" }, priceField(d))));
    app.appendChild(h("p", { class: "note", text: T("price_hint") }));

    if (!isNew) {
      app.appendChild(h("div", { class: "section", style: "margin-top:20px" }, h("label", { class: "row toggle" },
        h("input", { type: "checkbox", checked: !!d.p, onchange: function (e) { d.p = e.target.checked ? 1 : 0; } }),
        h("span", { class: "grow", text: T("pause_label") }))));
      app.appendChild(h("div", { style: "margin-top:20px" }, h("button", { class: "button danger", type: "button",
        onclick: function () { confirmAsk(T("confirm_delete"), function () { send({ v: 1, op: "delete", i: d.i }); }); } },
        T("delete_sub"))));
    }

    var error = h("p", { class: "error", hidden: true });
    app.appendChild(error);

    // ошибку показываем после первой попытки сохранить, а не с порога
    function validate() {
      var problem = !d.w.length ? T("err_words")
        : (d.f != null && d.t != null && d.f > d.t) ? T("err_price") : "";
      error.textContent = problem;
      error.hidden = !problem || !screen.tried;
      setMain(T("save"), save, true);
      return !problem;
    }

    function save() {
      // набранное, но не добавленное слово тоже сохраняем: blur добавляет его в список
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      screen.tried = true;
      if (!validate()) { haptic(); return; }
      send({ v: 1, op: "save", sub: { i: d.i, r: d.r, s: d.s, c: d.c, k: d.s === "kaspi" ? d.k : "",
                                        w: d.w, x: d.x, f: d.f, t: d.t, p: d.p ? 1 : 0 } });
    }

    screen.validate = validate;
    validate();
  }

  function parentOf(key) {
    if (!key) return "";
    var node = dirs.categories.byKey[key];
    if (!node) return "";
    return (dirs.categories.children[key] || []).length ? key : node.p;
  }

  function splitWords(text) {
    return text.split(",").map(function (w) { return w.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_WORD); })
      .filter(Boolean);
  }

  function chipsField(list, max, kind, onchange) {
    var chips = h("div", { class: "chips" + kind });
    var input = h("input", { type: "text", enterkeyhint: "done", autocomplete: "off",
                             placeholder: T("words_placeholder") });
    var note = h("p", { class: "note", hidden: true });

    function draw() {
      chips.innerHTML = "";
      list.forEach(function (word, index) {
        chips.appendChild(h("span", { class: "chip" }, h("span", { text: word }),
          h("button", { type: "button", "aria-label": "×", onclick: function () { list.splice(index, 1); draw(); onchange(); } }, "×")));
      });
      input.disabled = list.length >= max;
      note.hidden = list.length < max;
      note.textContent = T("words_full", { max: max });
    }

    function commit() {
      var added = false;
      splitWords(input.value).forEach(function (word) {
        var lower = word.toLowerCase();
        if (list.length < max && !list.some(function (w) { return w.toLowerCase() === lower; })) {
          list.push(word);
          added = true;
        }
      });
      input.value = "";
      if (added) { draw(); onchange(); haptic(); }
    }

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
    });
    input.addEventListener("input", function () { if (input.value.indexOf(",") >= 0) commit(); });
    input.addEventListener("blur", commit);

    draw();
    return h("div", null, chips, input, note);
  }

  function priceField(d) {
    function box(key, label) {
      var input = h("input", { type: "text", inputmode: "numeric", placeholder: label,
                               value: d[key] != null ? number(d[key]) : "" });
      input.addEventListener("input", function () {
        var digits = input.value.replace(/\D/g, "").slice(0, 10);
        d[key] = digits ? parseInt(digits, 10) : null;
        top().validate();
      });
      input.addEventListener("blur", function () { input.value = d[key] != null ? number(d[key]) : ""; });
      return input;
    }

    var from = box("f", T("price_from"));
    var to = box("t", T("price_to"));

    return h("div", null,
      h("div", { class: "pair" }, from, h("span", { text: "—" }), to),
      h("div", { class: "presets" },
        QUICK_PRICES.map(function (n) {
          return h("button", { class: "button small", type: "button",
            onclick: function () { d.f = null; d.t = n; from.value = ""; to.value = number(n); top().validate(); haptic(); } },
            quickLabel(n));
        }),
        h("button", { class: "button small", type: "button",
          onclick: function () { d.f = null; d.t = null; from.value = ""; to.value = ""; top().validate(); haptic(); } },
          T("price_any"))));
  }

  // ------------------------------------------------------------ город

  function renderCity(screen) {
    var d = screen.draft;
    var dir = dirs.cities[d.s];

    app.appendChild(h("h1", { text: T("city") }));

    var list = h("div", { class: "section" });
    var input = h("input", { type: "search", placeholder: T("city_search"), value: screen.query, autocomplete: "off" });

    function pick(key) { d.c = key; haptic(); pop(); }

    function fold(text) { return text.toLowerCase().replace(/ё/g, "е"); }

    function draw() {
      var q = fold(input.value.trim());
      screen.query = input.value;
      list.innerHTML = "";

      var items;
      if (!q) {
        list.appendChild(cityRow("", T("city_all"), ""));
        items = dir.top.map(function (k) { return dir.byKey[k]; });
      } else {
        items = dir.items.filter(function (c) { return fold(c.n).indexOf(q) >= 0; });
        var big = {};
        dir.top.forEach(function (k) { big[k] = true; });
        items.sort(function (a, b) {
          return (fold(a.n) !== q) - (fold(b.n) !== q) || (!big[a.k]) - (!big[b.k])
            || a.n.length - b.n.length || a.n.localeCompare(b.n);
        });
        items = items.slice(0, 50);
        if (!items.length) list.appendChild(h("div", { class: "row" }, h("span", { class: "grow", text: T("city_nothing") })));
      }
      items.forEach(function (c) { list.appendChild(cityRow(c.k, c.n, c.r && c.r !== c.n ? c.r : "")); });
    }

    function cityRow(key, name, region) {
      var selected = d.c === key;
      return h("button", { class: "row" + (selected ? " selected" : ""), type: "button", onclick: function () { pick(key); } },
        h("span", { class: "grow" }, h("div", { text: name }), region ? h("div", { class: "meta note", text: region }) : null),
        selected ? h("span", { class: "check", text: "✓" }) : null);
    }

    input.addEventListener("input", draw);
    app.appendChild(h("div", { class: "section" }, h("div", { class: "field" }, input)));
    app.appendChild(h("div", { style: "height:12px" }));
    app.appendChild(list);
    draw();
  }

  // ------------------------------------------------------------ категория

  function renderCategory(screen) {
    var d = screen.draft;
    var parent = screen.parent;
    var cats = dirs.categories;

    app.appendChild(h("h1", { text: parent ? cats.byKey[parent].n : T("category") }));
    if (parent) app.appendChild(h("p", { class: "note", text: categoryName(parent) }));

    function pick(key) {
      d.k = key;
      haptic();
      while (top().name === "category") stack.pop();
      render();
    }

    var rows = [];
    if (parent) {
      rows.push(h("button", { class: "row", type: "button", onclick: function () { pick(parent); } },
        h("span", { class: "grow", text: T("whole_section", { name: cats.byKey[parent].n }) }),
        d.k === parent ? h("span", { class: "check", text: "✓" }) : null));
    } else {
      rows.push(h("button", { class: "row", type: "button", onclick: function () { pick(""); } },
        h("span", { class: "grow", text: T("category_all") }), d.k === "" ? h("span", { class: "check", text: "✓" }) : null));
    }

    (cats.children[parent] || []).forEach(function (key) {
      var node = cats.byKey[key];
      var deeper = (cats.children[key] || []).length > 0;
      rows.push(h("button", { class: "row", type: "button",
        onclick: function () { if (deeper) push({ name: "category", draft: d, parent: key }); else pick(key); } },
        h("span", { class: "grow", text: node.n }),
        deeper ? h("span", { class: "chevron", text: "›" }) : (d.k === key ? h("span", { class: "check", text: "✓" }) : null)));
    });

    app.appendChild(h("div", { class: "section" }, rows));
  }

  // ------------------------------------------------------------ настройки

  function openSettings() {
    var q = state.q;
    push({ name: "settings", draft: { l: state.l, on: !!q, from: q ? q[0] : 23 * 60, to: q ? q[1] : 8 * 60,
                                      mode: q ? q[2] : (state.qm || "silent") } });
  }

  function timeSelect(value, onchange) {
    var options = [];
    for (var m = 0; m < 24 * 60; m += 30) options.push(m);
    if (options.indexOf(value) < 0) { options.push(value); options.sort(function (a, b) { return a - b; }); }
    return h("select", { onchange: function (e) { onchange(parseInt(e.target.value, 10)); } },
      options.map(function (m) { return h("option", { value: m, selected: m === value }, timeText(m)); }));
  }

  function renderSettings(screen) {
    var d = screen.draft;
    lang = d.l;                        // язык меняется сразу — для предпросмотра

    app.appendChild(h("h1", { text: T("settings") }));

    app.appendChild(sectionTitle(T("language")));
    app.appendChild(h("div", { class: "section" }, h("div", { class: "segmented" },
      [["ru", "Русский"], ["kk", "Қазақша"]].map(function (pair) {
        return h("button", { type: "button", class: d.l === pair[0] ? "on" : "",
                             onclick: function () { d.l = pair[0]; render(); } }, pair[1]);
      }))));

    app.appendChild(sectionTitle(T("quiet")));
    var quiet = [h("label", { class: "row toggle" },
      h("input", { type: "checkbox", checked: d.on, onchange: function (e) { d.on = e.target.checked; render(); } }),
      h("span", { class: "grow", text: T("quiet_on") }))];

    if (d.on) {
      quiet.push(h("div", { class: "field" }, h("div", { class: "pair" },
        h("label", { text: T("quiet_from") }), timeSelect(d.from, function (m) { d.from = m; check(); }),
        h("label", { text: T("quiet_to") }), timeSelect(d.to, function (m) { d.to = m; check(); }))));
      ["silent", "hold"].forEach(function (mode) {
        quiet.push(h("label", { class: "row toggle" },
          h("input", { type: "radio", name: "mode", checked: d.mode === mode, onchange: function () { d.mode = mode; } }),
          h("span", { class: "grow" }, h("div", { text: T("mode_" + mode) }),
            h("div", { class: "meta note", text: T("mode_" + mode + "_hint") }))));
      });
    }
    app.appendChild(h("div", { class: "section" }, quiet));
    app.appendChild(h("p", { class: "note", text: T("quiet_hint") }));

    var error = h("p", { class: "error", hidden: true });
    app.appendChild(error);

    function check() {
      var bad = d.on && d.from === d.to;
      error.textContent = bad ? T("err_quiet") : "";
      error.hidden = !bad;
      setMain(T("save"), save, !bad);
      return !bad;
    }

    function save() {
      if (!check()) return;
      send({ v: 1, op: "settings", sr: state.sr, l: d.l, q: d.on ? [d.from, d.to, d.mode] : null });
    }

    check();
  }

  // ------------------------------------------------------------ запуск

  function hashParam(name) {
    var parts = location.hash.replace(/^#/, "").split("&");
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq > 0 && parts[i].slice(0, eq) === name) return decodeURIComponent(parts[i].slice(eq + 1));
    }
    return null;
  }

  function fromBase64(text) {
    text = text.replace(/-/g, "+").replace(/_/g, "/");
    while (text.length % 4) text += "=";
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function decodeState(code) {
    var prefix = code.slice(0, 2);
    var bytes = fromBase64(code.slice(2));
    var ready;

    if (prefix === "j.") {
      ready = Promise.resolve(bytes);
    } else if (prefix === "z.") {
      if (!window.DecompressionStream) return Promise.reject(new Error("old"));
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      ready = new Response(stream).arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    } else {
      return Promise.reject(new Error("format"));
    }

    return ready.then(function (raw) { return JSON.parse(new TextDecoder().decode(raw)); });
  }

  function demoState() {
    // пример для проверки в обычном браузере: реальные ключи из справочников
    var olx = dirs.cities.olx.top[0] || "";
    var kaspi = dirs.cities.kaspi.top[0] || "";
    var laptops = Object.keys(dirs.categories.byKey).filter(function (k) {
      return /ноутбук/i.test(dirs.categories.byKey[k].n);
    })[0];
    var root = (dirs.categories.children[""] || [])[0] || "";
    var leaf = laptops || (dirs.categories.children[root] || [])[0] || root;
    return {
      v: 1, l: "ru", lim: 3, u: Math.floor(Date.now() / 1000) + 6 * 86400, pay: 1,
      src: ["olx", "kaspi"], sr: 0, q: [23 * 60, 8 * 60, "silent"], qm: "silent", mw: 5, mx: 10,
      subs: [
        { i: 1, s: "olx", c: olx, k: "", w: ["iphone 15", "айфон 15"], x: ["чехол", "чехл"], f: null, t: 500000, p: 0, r: 1 },
        { i: 2, s: "kaspi", c: kaspi, k: leaf, w: ["macbook"], x: [], f: 200000, t: 900000, p: 1, r: 1 }
      ]
    };
  }

  function fail(key) {
    app.innerHTML = "";
    app.appendChild(h("p", { class: "empty", text: T(key) }));
  }

  function getJSON(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(path + ": " + r.status);
      return r.json();
    });
  }

  function start() {
    if (inTelegram) {
      tg.ready();
      tg.expand();
      tg.MainButton.onClick(function () { if (mainAction) mainAction(); });
      tg.BackButton.onClick(pop);
    } else {
      document.getElementById("bottom-button").addEventListener("click", function () { if (mainAction) mainAction(); });
    }

    Promise.all([getJSON("i18n.json"), getJSON("data/olx_cities.json"),
                 getJSON("data/kaspi_cities.json"), getJSON("data/kaspi_categories.json")])
      .then(function (loaded) {
        i18n = loaded[0];
        dirs = prepareDirs(loaded[1], loaded[2], loaded[3]);

        var code = hashParam("s");

        if (!code) {
          if (inTelegram) { fail("open_again"); return null; }
          var banner = document.getElementById("banner");
          banner.textContent = T("demo_banner");
          banner.hidden = false;
          return demoState();
        }

        return decodeState(code).catch(function (e) {
          fail(e.message === "old" ? "old_telegram" : "open_again");
          return null;
        });
      })
      .then(function (loaded) {
        if (!loaded) return;
        if (loaded.v !== 1) { fail("open_again"); return; }
        state = loaded;
        lang = i18n[state.l] ? state.l : "ru";
        document.documentElement.lang = lang;
        stack = [{ name: "list" }];
        render();
      })
      .catch(function () {
        app.innerHTML = "";
        app.appendChild(h("p", { class: "empty", text: "Не удалось загрузить приложение. Проверьте интернет. · Қосымша жүктелмеді. Интернетті тексеріңіз." }));
      });
  }

  start();
})();
