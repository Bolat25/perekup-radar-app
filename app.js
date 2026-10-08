/* StuffTracker — Telegram Mini App без своего сервера.
 *
 * Откуда данные:
 *   - настройки подписчика бот кладёт в адрес кнопки: #s=j.<base64 JSON> или
 *     #s=z.<base64 deflate> (см. webapp_state.py). Хэш не уходит на сервер;
 *   - справочники — статические файлы data/*.json (tools/export_webapp.py):
 *     cities.json — общий список городов OLX + Kaspi, kaspi_categories.json,
 *     presets.json — готовые подписки (те же, что в чате; может отсутствовать),
 *     filters/*.json — товары, модели и фильтры OLX и Kaspi (если бот их включил: state.fc).
 * Куда уходят изменения:
 *   - Telegram.WebApp.sendData(JSON одной операции), до 4096 байт. После этого
 *     Telegram закрывает приложение, а бот отвечает в чате. Бот проверяет всё
 *     заново (webapp_ops.py) — здесь проверка только для удобства человека.
 * Блок «Что придёт» — правила бота на JS (match.js), их сверяет тест.
 * Без Telegram (обычный браузер) — демо: пример данных и показ операции.
 */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  // initData пустой у приложения с кнопки клавиатуры (а только с неё работает sendData),
  // поэтому Telegram узнаём по платформе: вне Telegram скрипт ставит «unknown»
  var inTelegram = !!(tg && (tg.initData || (tg.platform && tg.platform !== "unknown")));
  var match = window.PRMatch;

  var LABELS = { olx: "OLX", kaspi: "Kaspi" };
  var QUICK_PRICES = [100000, 300000, 500000, 1000000];
  var QUIET_PRESETS = [[23 * 60, 8 * 60], [0, 7 * 60], [22 * 60, 7 * 60]];
  var MAX_DATA = 4096;
  var MAX_WORD = 40;

  var i18n = null;      // {ru: {...}, kk: {...}}
  var dirs = null;      // справочники
  var state = null;     // состояние от бота
  var lang = "ru";
  var stack = [];       // экраны: {name, ...}
  var dockAction = null;

  var app = document.getElementById("app");

  // ------------------------------------------------------------ тексты и числа

  function T(key, params) {
    var text = (i18n && (i18n[lang][key] || i18n.ru[key])) || key;
    Object.keys(params || {}).forEach(function (name) {
      text = text.split("{" + name + "}").join(String(params[name]));
    });
    return text;
  }

  function number(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
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

  function two(x) { return (x < 10 ? "0" : "") + x; }

  function dateText(unix) {
    var d = new Date(unix * 1000);
    return two(d.getDate()) + "." + two(d.getMonth() + 1) + "." + d.getFullYear();
  }

  function timeText(minutes) { return two(Math.floor(minutes / 60)) + ":" + two(minutes % 60); }

  function speedText(seconds) {
    if (seconds == null) return "—";
    return seconds < 60 ? T("speed_sec", { n: seconds }) : T("speed_min", { n: Math.round(seconds / 60) });
  }

  function agoText(minutes) {
    if (minutes < 1) return T("ago_now");
    if (minutes < 60) return T("ago_min", { n: minutes });
    if (minutes < 1440) return T("ago_hour", { n: Math.floor(minutes / 60) });
    return T("ago_day", { n: Math.floor(minutes / 1440) });
  }

  function daysLeft(until) { return Math.max(0, Math.ceil((until * 1000 - Date.now()) / 86400000)); }

  // ------------------------------------------------------------ DOM

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value == null || value === false) return;
      if (key === "text") el.textContent = value;
      else if (key === "class") el.className = value;
      else if (key === "style") el.setAttribute("style", value);
      else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  function add(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { add(el, c); });
    else el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  var ICONS = {
    grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'
  };

  function icon(name) {
    var span = document.createElement("span");
    span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + "</svg>";
    return span.firstChild;
  }

  function sec(title, right) {
    return h("div", { class: "sec" }, h("h3", { text: title }), right ? h("span", { text: right }) : null);
  }

  function label(text, extra) {
    return h("div", { class: "label" }, h("span", { text: text }), extra ? h("em", { text: extra }) : null);
  }

  function navRow(iconName, title, value, onclick) {
    return h("button", { class: "row", type: "button", onclick: onclick },
      h("span", { class: "ico" }, icon(iconName)),
      h("span", { class: "grow", text: title }),
      value ? h("span", { class: "val", text: value }) : null,
      h("span", { class: "chev", text: "›" }));
  }

  // ------------------------------------------------------------ тема и кнопки

  function applyTheme() {
    var dark = inTelegram ? tg.colorScheme !== "light"
      : !(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    if (inTelegram) {
      var bg = dark ? "#0d0b1a" : "#f4f2fb";
      try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch (e) { /* старый клиент */ }
    }
  }

  function setDock(text, action, enabled) {
    dockAction = action;
    var button = document.getElementById("dock-button");
    button.textContent = text;
    button.disabled = enabled === false;
    document.getElementById("dock").hidden = false;
  }

  function hideDock() {
    dockAction = null;
    document.getElementById("dock").hidden = true;
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
    try {
      if (!inTelegram || !tg.HapticFeedback) return;
      if (kind === "error") tg.HapticFeedback.notificationOccurred("error");
      else if (kind === "light") tg.HapticFeedback.impactOccurred("light");
      else tg.HapticFeedback.selectionChanged();
    } catch (e) { /* старый клиент */ }
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
    hideDock();
    updateBack();
    if (!inTelegram && stack.length > 1) {
      // вне Telegram нет его кнопки «Назад» — рисуем свою
      app.appendChild(h("button", { class: "back", type: "button", onclick: pop }, "‹ " + T("back")));
    }
    ({ home: renderHome, editor: renderEditor, city: renderCity, category: renderCategory,
       product: renderProduct, settings: renderSettings })[screen.name](screen);
  }

  // ------------------------------------------------------------ отправка боту

  function send(op) {
    var text = JSON.stringify(op);
    if (new TextEncoder().encode(text).length > MAX_DATA) {
      showError(T("err_too_big"));
      return;
    }
    haptic("light");
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
    haptic("error");
  }

  // ------------------------------------------------------------ справочники

  function prepareDirs(cities, cats) {
    var items = cities.items.map(function (x) {
      return { o: x[0], k: x[1], n: x[2], r: x[3] || "", key: x[0] + "|" + x[1] };
    });
    var byKey = {}, byOlx = {}, byKaspi = {};
    items.forEach(function (c) {
      byKey[c.key] = c;
      if (c.o) byOlx[c.o] = c;
      if (c.k) byKaspi[c.k] = c;
    });
    var catKey = {}, children = { "": [] };
    cats.items.forEach(function (x) {
      var key = x[0], parent = key.indexOf("/") >= 0 ? key.slice(0, key.lastIndexOf("/")) : "";
      catKey[key] = { k: key, n: x[1], p: parent };
      (children[parent] = children[parent] || []).push(key);
    });
    return {
      cities: { items: items, byKey: byKey, byOlx: byOlx, byKaspi: byKaspi,
                top: cities.top.map(function (k) { return byKey[k]; }).filter(Boolean) },
      categories: { byKey: catKey, children: children }
    };
  }

  function cityEntry(c) {
    return (c[0] && dirs.cities.byOlx[c[0]]) || (c[1] && dirs.cities.byKaspi[c[1]]) || null;
  }

  function cityName(c) {
    if (!c[0] && !c[1]) return T("city_all");
    var entry = cityEntry(c);
    return entry ? entry.n : (c[0] || c[1]);
  }

  // город подходит площадке подписки: для «Везде» — только если есть на обеих
  function fits(entry, source) {
    if (source === "all") return !!(entry.o && entry.k);
    return !!entry[source === "olx" ? "o" : "k"];
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

  function canAll() { return state.src.indexOf("olx") >= 0 && state.src.indexOf("kaspi") >= 0; }
  function hasKaspi(source) { return source === "kaspi" || source === "all"; }

  // ------------------------------------------------------------ главная

  function renderHome() {
    var subs = state.subs;
    var count = state.cut || subs.length;     // cut — подписки не влезли в адрес
    var full = count >= state.lim;
    var active = state.u > Date.now() / 1000;
    var running = subs.some(function (s) { return !s.p; });

    app.appendChild(hero(active, running, count));
    app.appendChild(accessCard(active));

    app.appendChild(sec(T("subs"), T("subs_count", { count: count, limit: state.lim })));

    if (state.cut) {
      app.appendChild(h("div", { class: "empty-card" }, h("p", { text: T("cut_note") })));
    } else if (!subs.length) {
      app.appendChild(h("div", { class: "empty-card" },
        h("div", { class: "radar still", style: "margin:0 auto 14px" }),
        h("b", { text: T("no_subs_title") }), h("p", { text: T("no_subs") })));
    } else {
      subs.forEach(function (sub, index) { app.appendChild(subCard(sub, index)); });
    }

    if (full) app.appendChild(h("p", { class: "note", text: T("limit_note", { count: count, limit: state.lim }) }));

    app.appendChild(sec(T("settings")));
    app.appendChild(navRow("moon", T("quiet"), quietSummary(state.q), openSettings));
    app.appendChild(navRow("globe", T("language"), T("lang_name"), openSettings));
    app.appendChild(h("p", { class: "note", text: T("chat_hint") }));

    setDock(T("add_sub"), function () { openEditor(null); }, !full);
  }

  // яркий блок: сколько нашлось сегодня; кольца в углу — радар, луч бежит, пока он работает
  function hero(active, running, count) {
    var live = !active ? ["bad", T("live_closed")]
      : !count ? ["off", T("live_empty")]
      : running ? ["on", T("live_on")] : ["off", T("live_paused")];
    var st = state.st || {};

    return h("section", { class: "hero " + live[0] },
      h("div", { class: "orbit" }, live[0] === "on" ? h("i", { class: "sweep" }) : null),
      h("div", { class: "hero-top" },
        h("span", { class: "live " + live[0] }, h("i"), live[1].charAt(0).toUpperCase() + live[1].slice(1)),
        h("span", { class: "brand", text: T("app_title") })),
      h("div", { class: "big", text: st.d != null ? number(st.d) : "—" }),
      h("div", { class: "big-sub", text: T("stat_today") }),
      h("div", { class: "stats" },
        stat(st.w != null ? number(st.w) : "—", T("stat_week")),
        stat(speedText(st.m), T("stat_speed"))));
  }

  function stat(value, caption) {
    return h("div", { class: "stat" }, h("b", { text: value }), h("small", { text: caption }));
  }

  function accessCard(active) {
    var days = active ? daysLeft(state.u) : 0;
    var tile = h("div", { class: "days" }, active
      ? [h("b", { text: String(days) }), h("small", { text: T("days_short") })]
      : h("b", { text: "⛔" }));

    var text = active
      ? h("div", { class: "t" }, h("b", { text: T("access_until", { date: dateText(state.u) }) }),
          h("small", { text: T(state.pay ? "access_hint" : "access_days", { days: days }) }))
      : h("div", { class: "t" }, h("b", { text: T("access_closed") }),
          h("small", { text: T(state.pay ? "access_closed_pay" : "access_closed_nopay") }));

    var mood = !active ? " closed" : days <= 2 ? " soon" : "";

    return h("div", { class: "access" + mood }, tile, text,
      state.pay ? h("button", { class: "mini", type: "button",
        onclick: function () { send({ v: 1, op: "pay" }); } }, T(active ? "extend_btn" : "pay_btn")) : null);
  }

  function subCard(sub, index) {
    var paused = !!sub.p;
    var delay = "animation-delay:" + Math.min(index, 6) * 0.05 + "s";

    var toggle = h("button", { class: "sw" + (paused ? " off" : ""), type: "button",
      "aria-label": paused ? T("btn_resume") : T("btn_pause"),
      onclick: function (e) {
        e.stopPropagation();
        confirmAsk(T(paused ? "confirm_resume" : "confirm_pause"), function () {
          send({ v: 1, op: "pause", i: sub.i, p: paused ? 0 : 1 });
        });
      } });

    // площадки кружками, «где» строкой: «Везде · Астана»
    var where = (sub.s === "all" ? T("source_all") : LABELS[sub.s]) + (sub.ro ? "" : " · " + cityName(sub.c));
    var head = h("div", { class: "head" }, logos(sub.s), h("span", { class: "where", text: where }), toggle);

    if (sub.ro) {
      return h("div", { class: "card " + (paused ? "off" : "on"), style: delay }, head,
        h("div", { class: "title", text: (sub.w || []).join(" · ") + " …" }),
        h("p", { class: "note", text: T("ro_note") }),
        h("div", { class: "actions" }, h("button", { class: "ghost danger", type: "button",
          onclick: function () { confirmAsk(T("confirm_delete"), function () { send({ v: 1, op: "delete", i: sub.i }); }); } },
          T("btn_delete"))));
    }

    var tags = [];
    if (paused) tags.push(h("span", { class: "tag", text: T("paused_badge") }));
    if (sub.b) tags.push(h("span", { class: "tag", text: T("bumped_tag") }));
    if (sub.f != null || sub.t != null) tags.push(h("span", { class: "tag strong", text: priceText(sub.f, sub.t) }));
    if (hasKaspi(sub.s) && sub.k) {
      var node = dirs.categories.byKey[sub.k];
      tags.push(h("span", { class: "tag" }, icon("grid"), node ? node.n : sub.k));
    }
    // модели уже в заголовке, если слов нет; у своего товара вместо значка — его эмодзи
    if (flScoped(sub.fl)) {
      tags.push(h("span", { class: "tag" }, productOf(sub.fl.k) ? null : icon("grid"),
                  flSummary(sub.fl, !sub.w.length)));
    }
    sub.x.forEach(function (w) { tags.push(h("span", { class: "tag minus" }, h("span", { text: w }))); });

    return h("button", { class: "card " + (paused ? "off" : "on"), type: "button", style: delay,
                         onclick: function () { openEditor(sub); } },
      head,
      h("div", { class: "title", text: subTitle(sub) }),
      tags.length ? h("div", { class: "tags" }, tags) : null,
      activity(sub));
  }

  function logos(source) {
    var list = source === "all" ? ["olx", "kaspi"] : [source];
    return h("div", { class: "logos" }, list.map(function (s) {
      return h("span", { class: "lg " + s, title: LABELS[s], text: LABELS[s].charAt(0) });
    }));
  }

  function activity(sub) {
    if (sub.n == null) return null;
    var ago = sub.a;
    if (ago != null && ago >= 0 && state.st && state.st.t) {
      // «a» посчитано, когда бот собирал адрес; прибавляем, сколько прошло с тех пор
      ago += Math.max(0, Math.floor((Date.now() / 1000 - state.st.t) / 60));
    }
    var seen = ago != null && ago >= 0;
    // свежая находка (меньше часа) — точка пульсирует
    return h("div", { class: "week" },
      h("div", null, h("b", { text: number(sub.n) }), h("small", { text: T("stat_week") })),
      h("span", { class: "last" + (seen && ago < 60 ? " fresh" : "") },
        seen ? [h("i"), agoText(ago)] : T("nothing_yet")));
  }

  function quietSummary(q) {
    if (!q) return T("quiet_off");
    return timeText(q[0]) + "–" + timeText(q[1]) + ", " + T(q[2] === "hold" ? "mode_hold_short" : "mode_silent_short");
  }

  // ------------------------------------------------------------ редактор

  function openEditor(sub) {
    var source = sub ? sub.s : (canAll() ? "all" : state.src[0]);
    var draft = sub
      ? { i: sub.i, r: sub.r, s: sub.s, c: sub.c.slice(), k: sub.k, w: sub.w.slice(), x: sub.x.slice(),
          f: sub.f, t: sub.t, p: sub.p, b: sub.b ? 1 : 0 }
      : { i: null, r: null, s: source, c: ["", ""], k: "", w: [], x: [], f: null, t: null, p: 0, b: 0 };
    // фильтры товара — копия: пока не сохранили, подписка не меняется
    draft.fl = sub && sub.fl ? JSON.parse(JSON.stringify(sub.fl)) : {};
    draft.flDirty = false;
    push({ name: "editor", draft: draft });
  }

  // готовая подписка: слова, минус-слова и, если бот умеет фильтры, свой товар (как «ps» в чате)
  function usePreset(d, p) {
    d.w = p.w.slice();
    d.x = p.x.slice();
    var product = state.fc && p.k ? productOf(p.k) : null;
    if (!product) return;
    d.fl = { k: product.k, c: { olx: product.olx.slice(), kaspi: product.kaspi.slice() } };
    d.flDirty = true;
    narrowSource(d, product.olx, product.kaspi);
  }

  /* Смена площадки по правилу «Везде» (PLAN_V4 3.1): город, которого нет на
   * новой площадке, сбрасывается — и под полем видно почему; ничего не
   * сохраняется, пока человек сам не нажмёт «Сохранить». */
  function switchSource(d, source) {
    if (d.s === source) return;
    var entry = cityEntry(d.c);
    d.note = "";
    d.warn = "";

    if (entry) {
      if (fits(entry, source)) {
        d.c = source === "all" ? [entry.o, entry.k] : source === "olx" ? [entry.o, ""] : ["", entry.k];
      } else {
        var only = entry.o ? "olx" : "kaspi";
        d.warn = source === "all"
          ? T("city_reset", { city: entry.n, where: LABELS[only] })
          : T("city_missing", { city: entry.n, where: LABELS[source] });
        d.c = ["", ""];
      }
    }

    d.s = source;
    if (!hasKaspi(source)) d.k = "";
  }

  // выбор города: для «Везде» село одной площадки сужает подписку до неё (как в чате)
  function pickCity(d, entry) {
    d.warn = "";
    d.note = "";
    if (!entry) { d.c = ["", ""]; return; }
    if (d.s === "all" && !(entry.o && entry.k)) {
      var only = entry.o ? "olx" : "kaspi";
      d.note = T("city_only_on", { city: entry.n, where: LABELS[only] });
      d.s = only;
      if (!hasKaspi(only)) d.k = "";
    }
    d.c = d.s === "all" ? [entry.o, entry.k] : d.s === "olx" ? [entry.o, ""] : ["", entry.k];
  }

  function renderEditor(screen) {
    var d = screen.draft;
    var isNew = d.i == null;

    app.appendChild(h("h1", { text: isNew ? T("new_sub") : T("edit_sub") }));

    // быстрый старт: те же готовые подписки, что в чате (config.PRESETS)
    if (isNew && dirs.presets.length) {
      app.appendChild(label(T("quick_start")));
      app.appendChild(h("div", { class: "pills" }, dirs.presets.map(function (p) {
        var on = d.w.join("|") === p.w.join("|");
        return h("button", { type: "button", class: "pill" + (on ? " on" : ""),
          onclick: function () { usePreset(d, p); haptic(); render(); } }, p.label);
      })));
    }

    // слова (главное — сверху); минус-слова, площадки, поднятые — в «Дополнительно»
    var preview = h("div", { class: "preview" });
    function changed() { drawPreview(preview, d); validate(); }

    var byModels = state.fc && flModels(d.fl).length > 0;
    if (byModels) {
      app.appendChild(label(T("words")));
      app.appendChild(h("p", { class: "note", text: T("fl_models_words") }));
    } else {
      app.appendChild(label(T("words"), state.fc && flScoped(d.fl) ? T("optional") : ""));
      app.appendChild(chipsField(d.w, state.mw, "", changed));
      app.appendChild(h("p", { class: "note", text: T("words_hint", { max: state.mw }) }));
    }

    // товар, модели и фильтры (PLAN_FILTERS.md)
    if (state.fc) {
      var legacy = !flScoped(d.fl) && hasKaspi(d.s) && d.k ? categoryName(d.k) + " · Kaspi" : "";
      app.appendChild(label(T("product_label")));
      app.appendChild(navRow("grid", flSummary(d.fl) || legacy || T("product_any"), "", function () { openProduct(d); }));
    }

    // город
    app.appendChild(label(T("city")));
    var pills = [h("button", { type: "button", class: "pill" + (!d.c[0] && !d.c[1] ? " on" : ""),
      onclick: function () { pickCity(d, null); haptic(); render(); } }, T("city_all"))];
    var current = cityEntry(d.c);
    var shown = dirs.cities.top.filter(function (c) { return fits(c, d.s); });
    if (current && shown.indexOf(current) < 0) shown = [current].concat(shown);
    shown.slice(0, 8).forEach(function (c) {
      pills.push(h("button", { type: "button", class: "pill" + (current === c ? " on" : ""),
        onclick: function () { pickCity(d, c); haptic(); render(); } }, c.n));
    });
    pills.push(h("button", { type: "button", class: "pill",
      onclick: function () { push({ name: "city", draft: d, query: "" }); } }, "🔍 " + T("city_other")));
    app.appendChild(h("div", { class: "pills" }, pills));
    if (d.note) app.appendChild(h("p", { class: "note", text: d.note }));
    if (d.warn) app.appendChild(h("p", { class: "warn", text: d.warn }));

    // категория Kaspi (бот без фильтров товара; с ними она внутри «Товар и фильтры»)
    if (hasKaspi(d.s) && !state.fc) {
      app.appendChild(label(T("category"), d.s === "all" ? T("category_kaspi_only") : ""));
      app.appendChild(navRow("grid", categoryName(d.k), "", function () {
        push({ name: "category", draft: d, parent: parentOf(d.k) });
      }));
    }

    // цена
    app.appendChild(label(T("price")));
    app.appendChild(priceField(d));
    app.appendChild(h("p", { class: "note", text: T("price_hint") }));

    // «Дополнительно»: где искать, минус-слова, поднятые, проверка «Что придёт» — свёрнуто
    var sources = canAll() ? ["all", "olx", "kaspi"] : state.src;
    var extras = [sources.length > 1 ? (d.s === "all" ? T("source_all") : LABELS[d.s]) : "",
                  d.x.length ? T("extra_minus", { n: d.x.length }) : "",
                  d.b ? T("bumped_tag") : ""].filter(Boolean).join(" · ");
    app.appendChild(h("button", { type: "button", class: "row more-toggle", "aria-expanded": screen.more ? "true" : "false",
      onclick: function () { screen.more = !screen.more; haptic(); render(); } },
      h("span", { class: "grow" }, T("more_settings"), h("small", { text: extras || T("more_settings_hint") })),
      h("span", { class: "chev", text: screen.more ? "⌃" : "⌄" })));

    if (screen.more) {
      if (sources.length > 1) {
        app.appendChild(label(T("source")));
        app.appendChild(h("div", { class: "seg" }, sources.map(function (s) {
          return h("button", { type: "button", class: d.s === s ? "on" : "",
            onclick: function () { switchSource(d, s); haptic(); render(); } },
            s === "all" ? [h("span", { class: "dot o" }), h("span", { class: "dot k" }), T("source_all")]
                        : [h("span", { class: "dot " + s[0] }), LABELS[s]]);
        })));
        if (d.s === "all") app.appendChild(h("p", { class: "seg-hint", text: T("source_all_hint") }));
      }

      app.appendChild(label(T("minus")));
      app.appendChild(chipsField(d.x, state.mx, "minus", changed));
      app.appendChild(h("p", { class: "note", text: T("minus_hint", { max: state.mx }) }));

      if (!byModels) {
        app.appendChild(preview);
        drawPreview(preview, d);
      }

      // поднятые (старые объявления, которым обновили дату)
      app.appendChild(label(T("bumped")));
      app.appendChild(h("div", { class: "seg" }, [[0, T("bumped_drop")], [1, T("bumped_all")]].map(function (pair) {
        return h("button", { type: "button", class: d.b === pair[0] ? "on" : "",
          onclick: function () { d.b = pair[0]; haptic(); render(); } }, pair[1]);
      })));
      app.appendChild(h("p", { class: "seg-hint", text: T("bumped_hint") }));
    }

    if (!isNew) {
      app.appendChild(label(T("pause_label")));
      var sw = h("button", { class: "sw" + (d.p ? " off" : ""), type: "button",
        onclick: function () { d.p = d.p ? 0 : 1; sw.className = "sw" + (d.p ? " off" : ""); haptic(); } });
      app.appendChild(h("div", { class: "row" },
        h("span", { class: "grow", text: d.p ? T("btn_resume") : T("btn_pause") }), sw));
      app.appendChild(h("button", { class: "danger-btn", type: "button",
        onclick: function () { confirmAsk(T("confirm_delete"), function () { send({ v: 1, op: "delete", i: d.i }); }); } },
        T("delete_sub")));
    }

    var error = h("p", { class: "error", hidden: true });
    app.appendChild(error);

    // ошибку показываем после первой попытки сохранить, а не с порога
    function validate() {
      var scoped = state.fc && flScoped(d.fl);
      var problem = !d.w.length && !scoped ? T(state.fc ? "err_words_fl" : "err_words")
        : (d.f != null && d.t != null && d.f > d.t) ? T("err_price")
        : state.fc && rangeProblem(d.fl) ? T("err_range") : "";
      error.textContent = problem;
      error.hidden = !problem || !screen.tried;
      return !problem;
    }

    function save() {
      // набранное, но не добавленное слово тоже сохраняем: blur добавляет его в список
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      screen.tried = true;
      if (!validate()) { haptic("error"); return; }
      var sub = { i: d.i, r: d.r, s: d.s, c: d.c, k: hasKaspi(d.s) ? d.k : "",
                  w: d.w, x: d.x, f: d.f, t: d.t, p: d.p ? 1 : 0, b: d.b ? 1 : 0 };
      // фильтры — только если их меняли; старая категория Kaspi тогда заменяется ими
      // (в «Товар и фильтры» она стоит первой строкой — выбор переносит её в фильтры)
      if (state.fc && d.flDirty) {
        sub.fl = cleanFl(d.fl);
        sub.k = "";
        if (sub.fl.m) sub.w = [];       // модели вместо слов, как в чате
      }
      send({ v: 1, op: "save", sub: sub });
    }

    screen.validate = validate;
    validate();
    setDock(T("save_sub"), save, true);
  }

  // ------------------------------------------------------------ «Что придёт»

  function examples(d) {
    var first = d.w[0];
    if (!first) return [];
    var list = [T("ex_1", { w: first }), T("ex_2", { w: d.w[1] || first })];
    if (d.x.length) list.push(T("ex_minus", { m: capital(d.x[0]), w: first }));
    var parts = first.split(/\s+/);
    if (parts.length > 1) list.push(T("ex_partial", { first: capital(parts[0]) }));
    return list;
  }

  function capital(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  function exampleRow(title, d) {
    var result = match.check(title, d.w, d.x);
    var why = result.ok ? "" : result.minus ? T("preview_no_minus", { word: result.minus }) : T("preview_no_words");
    return h("div", { class: "ex " + (result.ok ? "yes" : "no") },
      h("span", { class: "m", text: result.ok ? "✓" : "✕" }),
      h("span", { class: "txt" }, title, why ? h("span", { class: "why", text: why }) : null));
  }

  function drawPreview(box, d) {
    box.innerHTML = "";
    box.appendChild(h("h4", null, icon("eye"), T("preview_title")));
    if (!d.w.length) {
      box.appendChild(h("p", { text: T("preview_empty") }));
      return;
    }
    examples(d).forEach(function (title) { box.appendChild(exampleRow(title, d)); });
    if (state.fc && flScoped(d.fl)) box.appendChild(h("p", { class: "note", text: T("preview_fl_note") }));

    var result = h("div");
    var probe = h("input", { class: "probe", type: "text", placeholder: T("preview_probe"), value: d.probe || "",
      oninput: function () { d.probe = probe.value; draw(); } });
    function draw() {
      result.innerHTML = "";
      if (probe.value.trim()) result.appendChild(exampleRow(probe.value.trim(), d));
    }
    box.appendChild(probe);
    box.appendChild(result);
    draw();
  }

  // ------------------------------------------------------------ поля

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
    var chips = h("div", { class: "chips" });
    var input = h("input", { type: "text", enterkeyhint: "done", autocomplete: "off",
                             placeholder: T("words_placeholder") });
    var note = h("p", { class: "note", hidden: true });

    function draw() {
      chips.innerHTML = "";
      list.forEach(function (word, index) {
        chips.appendChild(h("span", { class: "chip" + (kind ? " " + kind : "") }, h("span", { text: word }),
          h("button", { type: "button", "aria-label": "×",
                        onclick: function () { list.splice(index, 1); draw(); onchange(); haptic(); } }, "×")));
      });
      chips.hidden = !list.length;
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
    return h("div", null, h("div", { class: "inputbox" }, chips, input), note);
  }

  function priceField(d) {
    function box(key, caption) {
      var input = h("input", { type: "text", inputmode: "numeric", placeholder: "—",
                               value: d[key] != null ? number(d[key]) : "" });
      input.addEventListener("input", function () {
        var digits = input.value.replace(/\D/g, "").slice(0, 10);
        d[key] = digits ? parseInt(digits, 10) : null;
        top().validate();
        drawPills();
      });
      input.addEventListener("blur", function () { input.value = d[key] != null ? number(d[key]) : ""; });
      return { el: h("label", null, h("small", { text: caption }), input), input: input };
    }

    var from = box("f", T("price_from"));
    var to = box("t", T("price_to"));
    var pills = h("div", { class: "pills" });

    function set(low, high) {
      d.f = low; d.t = high;
      from.input.value = low != null ? number(low) : "";
      to.input.value = high != null ? number(high) : "";
      top().validate();
      drawPills();
      haptic();
    }

    function drawPills() {
      pills.innerHTML = "";
      QUICK_PRICES.forEach(function (n) {
        pills.appendChild(h("button", { type: "button", class: "pill" + (d.f == null && d.t === n ? " on" : ""),
          onclick: function () { set(null, n); } }, quickLabel(n)));
      });
      pills.appendChild(h("button", { type: "button", class: "pill" + (d.f == null && d.t == null ? " on" : ""),
        onclick: function () { set(null, null); } }, T("price_any")));
    }

    drawPills();
    return h("div", null, h("div", { class: "price" }, from.el, to.el), pills);
  }

  // ------------------------------------------------------------ город

  function renderCity(screen) {
    var d = screen.draft;
    var cities = dirs.cities;

    app.appendChild(h("h1", { text: T("city") }));

    var list = h("div");
    var input = h("input", { class: "search", type: "search", placeholder: T("city_search"),
                             value: screen.query, autocomplete: "off" });

    function fold(text) { return text.toLowerCase().replace(/ё/g, "е"); }

    // для одной площадки — только её города; для «Везде» — все: село одной
    // площадки сузит подписку до неё (pickCity)
    function allowed(c) { return d.s === "all" || fits(c, d.s); }

    function draw() {
      var q = fold(input.value.trim());
      screen.query = input.value;
      list.innerHTML = "";

      var items;
      if (!q) {
        list.appendChild(cityRow(null, T("city_all"), ""));
        items = cities.top.filter(allowed);
      } else {
        var big = {};
        cities.top.forEach(function (c) { big[c.key] = true; });
        items = cities.items.filter(function (c) { return allowed(c) && fold(c.n).indexOf(q) >= 0; });
        items.sort(function (a, b) {
          return (fold(a.n) !== q) - (fold(b.n) !== q) || (!big[a.key]) - (!big[b.key])
            || (!(a.o && a.k)) - (!(b.o && b.k)) || a.n.length - b.n.length || a.n.localeCompare(b.n);
        });
        items = items.slice(0, 60);
        if (!items.length) list.appendChild(h("p", { class: "note", text: T("city_nothing") }));
      }
      items.forEach(function (c) {
        var tag = d.s === "all" && !(c.o && c.k) ? T(c.o ? "only_olx" : "only_kaspi") : "";
        list.appendChild(cityRow(c, c.n, c.r && c.r !== c.n ? c.r : "", tag));
      });
    }

    function cityRow(entry, name, region, tag) {
      var selected = entry ? cityEntry(d.c) === entry : !d.c[0] && !d.c[1];
      return h("button", { class: "row" + (selected ? " sel" : ""), type: "button",
                           onclick: function () { pickCity(d, entry); haptic(); pop(); } },
        h("span", { class: "grow" }, name, region ? h("small", { text: region }) : null),
        tag ? h("span", { class: "tag", text: tag }) : null,
        selected ? h("span", { class: "check", text: "✓" }) : null);
    }

    input.addEventListener("input", draw);
    app.appendChild(input);
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

    function checkRow(text, key) {
      return h("button", { class: "row" + (d.k === key ? " sel" : ""), type: "button", onclick: function () { pick(key); } },
        h("span", { class: "grow", text: text }), d.k === key ? h("span", { class: "check", text: "✓" }) : null);
    }

    app.appendChild(parent ? checkRow(T("whole_section", { name: cats.byKey[parent].n }), parent)
                           : checkRow(T("category_all"), ""));

    (cats.children[parent] || []).forEach(function (key) {
      var node = cats.byKey[key];
      var deeper = (cats.children[key] || []).length > 0;
      if (!deeper) { app.appendChild(checkRow(node.n, key)); return; }
      app.appendChild(h("button", { class: "row", type: "button",
        onclick: function () { push({ name: "category", draft: d, parent: key }); } },
        h("span", { class: "grow", text: node.n }), h("span", { class: "chev", text: "›" })));
    });
  }

  // ------------------------------------------------------------ товар и фильтры (PLAN_FILTERS.md)
  //
  // Справочник выгружает tools/export_webapp.py: data/filters/index.json (свои товары
  // с меню моделей, категории OLX и Kaspi для поиска, пара Kaspi для категории OLX) и
  // файлы с уже «склеенными» фильтрами: p.json — свои товары, o<раздел>.json — OLX,
  // k.json — только Kaspi. Бот проверяет каждое сохранение сам (webapp_ops.check_filters).
  // fl уходит боту, только если его меняли здесь: иначе бот оставляет прежние фильтры.

  var fdir = { index: null, loading: null, files: {}, olxById: {}, kaspiByPath: {}, roots: {} };
  // главные и скрытые при модели фильтры — из выгрузки (номер у фильтра, mm/mh у товара),
  // своих копий правил здесь нет: чат и приложение не разойдутся (PLAN_UX.md, 3.1)
  // названия моделей — как в чате (telegram_bot.pretty_model)
  var MODEL_WORDS = { iphone: "iPhone", ipad: "iPad", macbook: "MacBook", airpods: "AirPods", watch: "Watch",
                      galaxy: "Galaxy", redmi: "Redmi", note: "Note", poco: "Poco", xiaomi: "Xiaomi",
                      xbox: "Xbox", "switch": "Switch", steam: "Steam", deck: "Deck", series: "Series" };
  var MODEL_UPPER = ["se", "xs", "xr", "x", "fe", "xt", "xtx", "oled", "ti", "rtx", "gtx", "rx", "e"];
  // пределы бота (webapp_ops.MAX_FILTER_*)
  var MAX_FILTER_MODELS = 30;
  var MAX_FILTER_VALUES = 60;
  var SHOWN_VALUES = 12;
  var SEPARATORS = /[^0-9a-zа-яёәғқңөұүһі]+/g;

  function ensureIndex() {
    if (fdir.index) return Promise.resolve(fdir.index);
    if (!fdir.loading) {
      fdir.loading = getJSON("data/filters/index.json").then(function (index) {
        index.o.forEach(function (row) { fdir.olxById[row[0]] = row; });
        index.k.forEach(function (row) { fdir.kaspiByPath[row[0]] = row[1]; });
        index.r.forEach(function (row) { fdir.roots[row[0]] = row[1]; });
        fdir.index = index;
        return index;
      }, function (e) { fdir.loading = null; throw e; });
    }
    return fdir.loading;
  }

  function productOf(key) {
    if (!fdir.index || !key) return null;
    return fdir.index.p.filter(function (p) { return p.k === key; })[0] || null;
  }

  function productName(p) { return p.e + " " + (lang === "kk" ? p.kk : p.ru); }

  function prettyModel(key) {
    if (/ \*$/.test(key)) return T("model_line", { model: prettyModel(key.slice(0, -2)) });
    return key.split(" ").map(function (w) {
      if (MODEL_WORDS.hasOwnProperty(w)) return MODEL_WORDS[w];
      if (MODEL_UPPER.indexOf(w) >= 0 || w.indexOf("ps") === 0) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function flCats(fl) {
    var c = (fl && fl.c) || {};
    return { olx: c.olx || [], kaspi: c.kaspi || [] };
  }

  // категория или модели выбраны — слова не обязательны (как в чате и у бота)
  function flScoped(fl) {
    var c = flCats(fl);
    return !!(c.olx.length || c.kaspi.length || (fl && fl.m && fl.m.length));
  }

  function flModels(fl) { return (fl && fl.m) || []; }

  function flCategory(fl) {
    var p = productOf(fl.k);
    if (p) return productName(p);
    var c = flCats(fl);
    if (c.olx.length && fdir.olxById[c.olx[0]]) return fdir.olxById[c.olx[0]][1].split(" → ").pop();
    if (c.kaspi.length && fdir.kaspiByPath[c.kaspi[0]]) return fdir.kaspiByPath[c.kaspi[0]].split(" → ").pop();
    return "";
  }

  // «📱 Смартфоны · iPhone 15 Pro · фильтров: 2» — карточка и строка редактора
  function flSummary(fl, noModels) {
    if (!flScoped(fl)) return "";
    var parts = [flCategory(fl)].filter(Boolean);
    var models = noModels ? [] : flModels(fl).map(prettyModel);
    if (models.length) parts.push(models.slice(0, 2).join(", ") + (models.length > 2 ? " +" + (models.length - 2) : ""));
    var n = Object.keys(fl.f || {}).length + Object.keys(fl.r || {}).length;
    if (n) parts.push(T("fl_count", { n: n }));
    return parts.join(" · ");
  }

  // заголовок подписки без слов: модели или категория (telegram_bot._category_or_models)
  function subTitle(sub) {
    if (sub.w && sub.w.length) return sub.w.join(" · ");
    var models = flModels(sub.fl).map(prettyModel);
    if (models.length) return models.join(" · ");
    return flCategory(sub.fl || {}) || "…";
  }

  function filterFile(fl) {
    var c = flCats(fl);
    if (fl.k) return { file: "p.json", key: fl.k };
    if (c.olx.length && fdir.olxById[c.olx[0]]) return { file: "o" + fdir.olxById[c.olx[0]][2] + ".json", key: String(c.olx[0]) };
    if (c.kaspi.length) return { file: "k.json", key: c.kaspi[0] };
    return null;
  }

  function loadFilters(fl) {
    var ref = filterFile(fl);
    if (!ref) return Promise.resolve([]);
    var ready = fdir.files[ref.file] ? Promise.resolve(fdir.files[ref.file])
      : getJSON("data/filters/" + ref.file).then(function (file) { fdir.files[ref.file] = file; return file; });
    return ready.then(function (file) { return file[ref.key] || []; });
  }

  // выбранные значения, которых больше нет в справочнике (его обновили), — убрать
  function pruneFilters(fl, filters) {
    var kinds = {};
    filters.forEach(function (f) { kinds[f[0]] = f; });
    Object.keys(fl.f || {}).forEach(function (key) {
      var f = kinds[key];
      var known = f && f[1] !== "range" ? f[5].map(function (v) { return v[0]; }) : [];
      fl.f[key] = fl.f[key].filter(function (v) { return known.indexOf(v) >= 0; });
      if (!fl.f[key].length) delete fl.f[key];
    });
    Object.keys(fl.r || {}).forEach(function (key) {
      if (!kinds[key] || kinds[key][1] !== "range") delete fl.r[key];
    });
  }

  /* Категория есть не на всех площадках подписки — подписка сужается до той, где
   * она есть (telegram_bot._source_note и webapp_ops._apply_filters): «Везде» +
   * только OLX-категория → OLX; «OLX» + только Kaspi-категория → Kaspi. */
  function narrowSource(d, olx, kaspi) {
    var has = [];
    if (olx.length) has.push("olx");
    if (kaspi.length) has.push("kaspi");
    var current = d.s === "all" ? ["olx", "kaspi"] : [d.s];
    if (!has.length || current.every(function (s) { return has.indexOf(s) >= 0; })) return;
    var keep = current.filter(function (s) { return has.indexOf(s) >= 0; });
    if (!keep.length) keep = has;
    var source = keep.length === 2 ? "all" : keep[0];
    if (source === "all" ? !canAll() : state.src.indexOf(source) < 0) return;
    d.s = source;
    if (keep.indexOf("olx") < 0) d.c[0] = "";
    if (keep.indexOf("kaspi") < 0) d.c[1] = "";
    if (!hasKaspi(d.s)) d.k = "";
    d.warn = "";
    d.note = T("fl_only_on", { where: LABELS[source] || T("source_all") });
  }

  // что уходит боту: только непустые части
  function cleanFl(fl) {
    if (!flScoped(fl)) return {};
    var c = flCats(fl), out = { c: { olx: c.olx.slice(), kaspi: c.kaspi.slice() } };
    if (fl.k) out.k = fl.k;
    if (flModels(fl).length) out.m = fl.m.slice();
    if (fl.f && Object.keys(fl.f).length) out.f = fl.f;
    if (fl.r && Object.keys(fl.r).length) out.r = fl.r;
    return out;
  }

  function rangeProblem(fl) {
    return Object.keys((fl && fl.r) || {}).some(function (key) {
      var r = fl.r[key];
      return r[0] != null && r[1] != null && r[0] > r[1];
    });
  }

  function openProduct(d) {
    push({ name: "product", draft: d, step: "cat", query: "" });
  }

  function doneProduct() {
    while (top().name === "product") stack.pop();
    render();
    window.scrollTo(0, 0);
  }

  function renderProduct(screen) {
    if (!fdir.index) {
      app.appendChild(h("p", { class: "note", text: T("loading") }));
      ensureIndex().then(function () { if (top() === screen) render(); },
                         function () { if (top() === screen) showError(T("err_load")); });
      return;
    }
    ({ cat: renderProductCat, model: renderProductModel, filters: renderProductFilters })[screen.step](screen, screen.draft);
  }

  // ---- шаг 1: товар или категория

  function renderProductCat(screen, d) {
    app.appendChild(h("h1", { text: T("product_title") }));
    app.appendChild(h("p", { class: "note", text: T("product_hint") }));

    function sameCats(olx, kaspi) {
      var c = flCats(d.fl);
      return c.olx.join("|") === olx.join("|") && c.kaspi.join("|") === kaspi.join("|");
    }

    function choose(olx, kaspi, key) {
      var old = d.fl;
      var same = sameCats(olx, kaspi) && (old.k || "") === (key || "");
      d.fl = { c: { olx: olx.slice(), kaspi: kaspi.slice() } };
      if (key) d.fl.k = key;
      // та же категория — модели и фильтры остаются
      if (same) ["m", "f", "r"].forEach(function (k) { if (old[k]) d.fl[k] = old[k]; });
      d.flDirty = true;
      narrowSource(d, olx, kaspi);
      haptic();
      push({ name: "product", draft: d, step: key ? "model" : "filters" });
    }

    app.appendChild(h("div", { class: "pills" }, fdir.index.p.map(function (p) {
      return h("button", { type: "button", class: "pill" + (d.fl.k === p.k ? " on" : ""),
        onclick: function () { choose(p.olx, p.kaspi, p.k); } }, productName(p));
    })));

    var input = h("input", { class: "search", type: "search", placeholder: T("product_search"),
                             value: screen.query || "", autocomplete: "off" });
    var list = h("div");

    function fold(text) { return text.toLowerCase().replace(/ё/g, "е"); }

    function row(name, small, tag, onclick, selected) {
      return h("button", { class: "row" + (selected ? " sel" : ""), type: "button", onclick: onclick },
        h("span", { class: "grow" }, name, small ? h("small", { text: small }) : null),
        tag ? h("span", { class: "tag", text: tag }) : null,
        selected ? h("span", { class: "check", text: "✓" }) : null);
    }

    function draw() {
      var q = fold(input.value.trim());
      screen.query = input.value;
      list.innerHTML = "";
      list.appendChild(row(T("product_none"), "", "", function () {
        d.fl = {};
        d.flDirty = true;
        haptic();
        doneProduct();
      }, !flScoped(d.fl)));
      if (q.length < 2) return;

      // свои товары: по названию и по моделям («iphone 15» → Смартфоны)
      var products = fdir.index.p.filter(function (p) {
        return [p.ru, p.kk].concat(p.menu.map(function (g) { return g[0]; })).some(function (name) {
          return fold(name).indexOf(q) >= 0;
        });
      });
      products.forEach(function (p) {
        list.appendChild(row(productName(p), "", "OLX + Kaspi", function () { choose(p.olx, p.kaspi, p.k); },
                             d.fl.k === p.k));
      });

      // сначала совпадение с начала слова в названии, потом в разделе, потом внутри слова:
      // «шины» — «Автошины» и «Шины, диски…» выше, чем «Стиральные машины»
      var words = " " + q.replace(SEPARATORS, " ");
      function rank(name, path) {
        var n = " " + fold(name).replace(SEPARATORS, " "), p = " " + fold(path).replace(SEPARATORS, " ");
        return n.indexOf(words) >= 0 ? 0 : p.indexOf(words) >= 0 ? 1 : n.indexOf(q) >= 0 ? 2 : p.indexOf(q) >= 0 ? 3 : -1;
      }

      var found = [];
      function add(name, path, olx, kaspi) {
        var score = rank(name, path);
        if (score >= 0) found.push({ name: name, path: path, olx: olx, kaspi: kaspi, score: score });
      }
      fdir.index.o.forEach(function (r) {
        var parts = r[1].split(" → ");
        var name = parts.pop();
        add(name, [fdir.roots[r[2]] || ""].concat(parts).join(" → "), [r[0]], r[3] ? [r[3]] : []);
      });
      fdir.index.k.forEach(function (r) {
        var parts = r[1].split(" → ");
        var name = parts.pop();
        add(name, parts.join(" → "), [], [r[0]]);
      });
      found.sort(function (a, b) { return a.score - b.score || a.name.length - b.name.length; });
      if (!found.length && !products.length) list.appendChild(h("p", { class: "note", text: T("product_nothing") }));
      found.slice(0, 40).forEach(function (f) {
        var tag = f.olx.length && f.kaspi.length ? "OLX + Kaspi" : f.olx.length ? "OLX" : "Kaspi";
        list.appendChild(row(f.name, f.path, tag, function () { choose(f.olx, f.kaspi, ""); },
                             !d.fl.k && sameCats(f.olx, f.kaspi)));
      });
    }

    // сейчас выбрано (категория не своего товара) или старая категория Kaspi — одним
    // нажатием к её фильтрам, без поиска; старая так переносится в фильтры, как в чате
    var current = null;
    if (flScoped(d.fl) && !d.fl.k) {
      var c = flCats(d.fl);
      current = { name: flCategory(d.fl) || "…", olx: c.olx, kaspi: c.kaspi };
    } else if (!flScoped(d.fl) && d.k && hasKaspi(d.s) && fdir.kaspiByPath[d.k]) {
      current = { name: fdir.kaspiByPath[d.k].split(" → ").pop(), olx: [], kaspi: [d.k] };
    }
    if (current) {
      var tag = current.olx.length && current.kaspi.length ? "OLX + Kaspi" : current.olx.length ? "OLX" : "Kaspi";
      app.appendChild(label(T("product_current")));
      app.appendChild(row(current.name, T("product_current_hint"), tag,
                          function () { choose(current.olx, current.kaspi, ""); }, true));
    }

    input.addEventListener("input", draw);
    app.appendChild(input);
    app.appendChild(list);
    draw();
  }

  // ---- шаг 2: модели своего товара

  function lineKey(models) {
    var first = models[0];
    return models.every(function (m) { return m === first || m.indexOf(first + " ") === 0; }) ? first + " *" : null;
  }

  function renderProductModel(screen, d) {
    var p = productOf(d.fl.k);
    if (!p) { screen.step = "filters"; render(); return; }

    function chosen() { return d.fl.m || []; }

    // «Все iPhone 15» и отдельные iPhone 15 одной группы друг друга заменяют
    function toggle(model, drop) {
      var list = chosen().filter(function (m) { return drop.indexOf(m) < 0; });
      var i = list.indexOf(model);
      if (i >= 0) list.splice(i, 1);
      else if (list.length >= MAX_FILTER_MODELS) { showError(T("too_many", { n: MAX_FILTER_MODELS })); return; }
      else list.push(model);
      d.fl.m = list;
      d.flDirty = true;
      haptic();
      render();
    }

    app.appendChild(h("h1", { text: T("model_title") }));
    app.appendChild(h("p", { class: "note", text: T("model_hint") }));
    app.appendChild(h("div", { class: "pills" }, h("button", { type: "button", class: "pill" + (chosen().length ? "" : " on"),
      onclick: function () { d.fl.m = []; d.flDirty = true; haptic(); render(); } }, T("model_any"))));

    p.menu.forEach(function (group) {
      var models = group[1], line = lineKey(models);
      var pills = [];
      app.appendChild(label(group[0]));
      if (line) {
        pills.push(h("button", { type: "button", class: "pill" + (chosen().indexOf(line) >= 0 ? " on" : ""),
          onclick: function () { toggle(line, models); } }, T("model_line_all", { line: group[0] })));
      }
      models.forEach(function (m) {
        pills.push(h("button", { type: "button", class: "pill" + (chosen().indexOf(m) >= 0 ? " on" : ""),
          onclick: function () { toggle(m, line ? [line] : []); } }, prettyModel(m)));
      });
      app.appendChild(h("div", { class: "pills" }, pills));
    });

    setDock(T("next"), function () { push({ name: "product", draft: d, step: "filters" }); }, true);
  }

  // ---- шаг 3: фильтры категории — все сразу, у каждого «Любой»

  function renderProductFilters(screen, d) {
    app.appendChild(h("h1", { text: T("filters_title") }));
    var summary = flSummary(d.fl);
    if (summary) app.appendChild(h("p", { class: "note", text: summary }));
    var box = h("div", null, h("p", { class: "note", text: T("loading") }));
    app.appendChild(box);
    setDock(T("done"), doneProduct, true);

    loadFilters(d.fl).then(function (filters) {
      if (top() !== screen) return;
      pruneFilters(d.fl, filters);
      var parts = filterMenu(d, filters);
      screen.open = screen.open || {};

      box.innerHTML = "";
      if (!parts.main.length) box.appendChild(h("p", { class: "note", text: T("filters_none") }));
      parts.main.forEach(function (f) { box.appendChild(filterBlock(d, f)); });

      if (parts.more.length) {
        box.appendChild(h("button", { type: "button", class: "row more-toggle", "aria-expanded": screen.more ? "true" : "false",
          onclick: function () { screen.more = !screen.more; haptic(); render(); } },
          h("span", { class: "grow", text: T(screen.more ? "filters_less" : "filters_more", { n: parts.more.length }) }),
          h("span", { class: "chev", text: screen.more ? "⌃" : "⌄" })));

        if (screen.more) {
          parts.more.forEach(function (f) {
            if (screen.open[f[0]]) { box.appendChild(filterBlock(d, f)); return; }
            // свёрнутый фильтр — строка «Название · значение», раскрывается по нажатию
            box.appendChild(h("button", { type: "button", class: "row", "aria-expanded": "false",
              onclick: function () { screen.open[f[0]] = true; haptic(); render(); } },
              h("span", { class: "grow", text: filterName(f) }),
              h("span", { class: "val", text: filterValue(d, f) }),
              h("span", { class: "chev", text: "›" })));
          });
        }
      }
    }, function () {
      if (top() !== screen) return;
      box.innerHTML = "";
      showError(T("err_load"));
    });
  }

  // главные — по номеру из выгрузки (как в чате); выбрана модель своего товара — mm/mh товара
  function filterMenu(d, filters) {
    var p = productOf(d.fl.k), withModels = flModels(d.fl).length > 0 && p;
    var hidden = withModels ? p.mh || [] : [];
    var shown = filters.filter(function (f) { return hidden.indexOf(f[0]) < 0; });
    var main;
    if (withModels) {
      main = (p.mm || []).map(function (k) { return shown.filter(function (f) { return f[0] === k; })[0]; })
        .filter(Boolean);
    } else {
      main = shown.filter(function (f) { return f[6]; }).sort(function (a, b) { return a[6] - b[6]; });
    }
    return { main: main, more: shown.filter(function (f) { return main.indexOf(f) < 0; }) };
  }

  function filterName(f) {
    return (lang === "kk" && f[3] ? f[3] : f[2]) + (f[4] ? ", " + f[4] : "");
  }

  // текущее значение фильтра для заголовка: «256 Гб, 512 Гб», «2015–2020», «любой»
  function filterValue(d, f) {
    var text;
    if (f[1] === "range") {
      var r = (d.fl.r || {})[f[0]];
      text = !r ? "" : r[0] != null && r[1] != null ? r[0] + "–" + r[1]
        : r[0] != null ? T("range_from_n", { n: r[0] }) : T("range_to_n", { n: r[1] });
    } else {
      var labels = {};
      f[5].forEach(function (v) { labels[v[0]] = v[1]; });
      text = ((d.fl.f || {})[f[0]] || []).map(function (k) { return labels[k] || k; }).join(", ");
    }
    if (!text) return T("filter_value_any");
    return text.length > 28 ? text.slice(0, 27) + "…" : text;
  }

  function filterBlock(d, f) {
    var key = f[0], kind = f[1], values = f[5];
    var head = label(filterName(f), filterValue(d, f));
    var block = h("div", { class: "filter" }, head);
    // значение в заголовке обновляется сразу, без перерисовки экрана
    function refresh() { var em = head.querySelector("em"); if (em) em.textContent = filterValue(d, f); }

    if (kind === "range") {
      var r = ((d.fl.r || {})[key] || [null, null]).slice();
      var hint = h("p", { class: "warn", hidden: true, text: T("err_range") });
      var set = function (i, text) {
        var digits = text.replace(/\D/g, "").slice(0, 10);
        r[i] = digits ? parseInt(digits, 10) : null;
        d.fl.r = d.fl.r || {};
        if (r[0] == null && r[1] == null) delete d.fl.r[key]; else d.fl.r[key] = r.slice();
        d.flDirty = true;
        hint.hidden = !(r[0] != null && r[1] != null && r[0] > r[1]);
        refresh();
      };
      var box = function (i, caption) {
        return h("label", null, h("small", { text: caption }),
          h("input", { type: "text", inputmode: "numeric", placeholder: T("filter_any"),
                       value: r[i] == null ? "" : String(r[i]), oninput: function (e) { set(i, e.target.value); } }));
      };
      block.appendChild(h("div", { class: "price" }, box(0, T("price_from")), box(1, T("price_to"))));
      block.appendChild(hint);
      hint.hidden = !(r[0] != null && r[1] != null && r[0] > r[1]);
      return block;
    }

    var pills = h("div", { class: "pills" });
    var query = "";

    function chosen() { return (d.fl.f || {})[key] || []; }

    function pill(text, on, onclick) {
      return h("button", { type: "button", class: "pill" + (on ? " on" : ""), onclick: onclick }, text);
    }

    function pick(value) {
      var next = chosen().slice(), i = next.indexOf(value);
      if (i >= 0) next.splice(i, 1);
      else if (next.length >= MAX_FILTER_VALUES) { showError(T("too_many", { n: MAX_FILTER_VALUES })); return; }
      else next.push(value);
      d.fl.f = d.fl.f || {};
      if (next.length) d.fl.f[key] = next.sort(); else delete d.fl.f[key];
      d.flDirty = true;
      haptic();
      draw();
      refresh();
    }

    function draw() {
      var list = chosen();
      var q = query.toLowerCase();
      var shown = values.filter(function (v) { return !q || v[1].toLowerCase().indexOf(q) >= 0; });
      var more = 0;
      if (!q && shown.length > SHOWN_VALUES) {
        more = shown.length - SHOWN_VALUES;
        // выбранные видны всегда
        shown = shown.slice(0, SHOWN_VALUES).concat(shown.slice(SHOWN_VALUES).filter(function (v) {
          return list.indexOf(v[0]) >= 0;
        }));
      }
      pills.innerHTML = "";
      pills.appendChild(pill(T("filter_any"), !list.length, function () {
        if (d.fl.f) delete d.fl.f[key];
        d.flDirty = true;
        haptic();
        draw();
        refresh();
      }));
      shown.forEach(function (v) {
        pills.appendChild(pill(v[1], list.indexOf(v[0]) >= 0, function () { pick(v[0]); }));
      });
      if (more) pills.appendChild(h("p", { class: "note full", text: T("values_more", { n: more }) }));
      if (q && !shown.length) pills.appendChild(h("p", { class: "note full", text: T("values_nothing") }));
    }

    if (values.length > SHOWN_VALUES) {
      block.appendChild(h("input", { class: "search", type: "search", placeholder: T("value_search"), autocomplete: "off",
        oninput: function (e) { query = e.target.value.trim(); draw(); } }));
    }
    block.appendChild(pills);
    draw();
    return block;
  }

  // ------------------------------------------------------------ настройки

  function openSettings() {
    var q = state.q;
    push({ name: "settings", draft: { l: state.l, on: !!q, from: q ? q[0] : 23 * 60, to: q ? q[1] : 8 * 60,
                                      mode: q ? q[2] : (state.qm || "silent"), custom: false } });
  }

  function timeSelect(value, onchange) {
    var options = [];
    for (var m = 0; m < 24 * 60; m += 30) options.push(m);
    if (options.indexOf(value) < 0) { options.push(value); options.sort(function (a, b) { return a - b; }); }
    return h("select", { onchange: function (e) { onchange(parseInt(e.target.value, 10)); } },
      options.map(function (m) { return h("option", { value: m, selected: m === value }, timeText(m)); }));
  }

  // циферблат: ночное окно закрашено; полночь сверху
  function clockFace(from, to) {
    var a = from / 1440 * 360, b = to / 1440 * 360;
    var night = "var(--violet)", day = "var(--surface-2)";
    var gradient = from < to
      ? day + " 0 " + a + "deg, " + night + " " + a + "deg " + b + "deg, " + day + " " + b + "deg 360deg"
      : night + " 0 " + b + "deg, " + day + " " + b + "deg " + a + "deg, " + night + " " + a + "deg 360deg";
    var length = ((to - from) + 1440) % 1440;

    // подписи часов — снаружи кольца; время в центре в две строки: «с» и «до»
    return h("div", { class: "clockwrap" },
      h("span", { class: "h t", text: "00" }),
      h("span", { class: "h r", text: "06" }),
      h("span", { class: "h b", text: "12" }),
      h("span", { class: "h l", text: "18" }),
      h("div", { class: "clock", style: "background:conic-gradient(" + gradient + ")" },
        h("div", { class: "in" }, h("div", null,
          h("b", { text: timeText(from) }), h("i"), h("b", { text: timeText(to) }),
          h("small", { text: T("quiet_hours", { n: Math.round(length / 60 * 10) / 10 }) })))));
  }

  function renderSettings(screen) {
    var d = screen.draft;
    lang = d.l;                        // язык меняется сразу — для предпросмотра

    app.appendChild(h("h1", { text: T("settings") }));

    app.appendChild(label(T("language")));
    app.appendChild(h("div", { class: "seg" }, [["ru", "Русский"], ["kk", "Қазақша"]].map(function (pair) {
      return h("button", { type: "button", class: d.l === pair[0] ? "on" : "",
                           onclick: function () { d.l = pair[0]; haptic(); render(); } }, pair[1]);
    })));

    var sw = h("button", { class: "sw" + (d.on ? "" : " off"), type: "button",
      onclick: function () { d.on = !d.on; haptic(); render(); } });
    app.appendChild(label(T("quiet")));
    app.appendChild(h("div", { class: "row" }, h("span", { class: "ico" }, icon("moon")),
      h("span", { class: "grow", text: d.on ? T("quiet_enabled") : T("quiet_off") }), sw));

    if (d.on) {
      app.appendChild(clockFace(d.from, d.to));

      var preset = QUIET_PRESETS.filter(function (p) { return p[0] === d.from && p[1] === d.to; })[0];
      var pills = QUIET_PRESETS.map(function (p) {
        return h("button", { type: "button", class: "pill" + (preset === p && !d.custom ? " on" : ""),
          onclick: function () { d.from = p[0]; d.to = p[1]; d.custom = false; haptic(); render(); } },
          timeText(p[0]) + "–" + timeText(p[1]));
      });
      pills.push(h("button", { type: "button", class: "pill" + (d.custom || !preset ? " on" : ""),
        onclick: function () { d.custom = true; render(); } }, T("quiet_custom")));
      app.appendChild(h("div", { class: "pills", style: "justify-content:center;margin-top:14px" }, pills));

      if (d.custom || !preset) {
        app.appendChild(h("div", { class: "times" },
          h("label", null, h("small", { text: T("quiet_from") }),
            timeSelect(d.from, function (m) { d.from = m; render(); })),
          h("label", null, h("small", { text: T("quiet_to") }),
            timeSelect(d.to, function (m) { d.to = m; render(); }))));
      }

      app.appendChild(label(T("quiet_night")));
      app.appendChild(h("div", { class: "modes" }, ["silent", "hold"].map(function (mode) {
        var title = T("mode_" + mode);
        return h("button", { type: "button", class: "mode" + (d.mode === mode ? " on" : ""),
          onclick: function () { d.mode = mode; haptic(); render(); } },
          title.slice(0, 2), h("b", { text: title.slice(2).trim() }), h("small", { text: T("mode_" + mode + "_hint") }));
      })));
    }
    app.appendChild(h("p", { class: "note", text: T("quiet_hint") }));

    var error = h("p", { class: "error", hidden: true });
    app.appendChild(error);

    var bad = d.on && d.from === d.to;
    error.textContent = bad ? T("err_quiet") : "";
    error.hidden = !bad;

    setDock(T("save"), function () {
      if (d.on && d.from === d.to) { haptic("error"); return; }
      send({ v: 1, op: "settings", sr: state.sr, l: d.l, q: d.on ? [d.from, d.to, d.mode] : null });
    }, !bad);
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
    var both = dirs.cities.top.filter(function (c) { return c.o && c.k; });
    var astana = both[0] || { o: "", k: "" };
    var almaty = both[1] || astana;
    var laptops = Object.keys(dirs.categories.byKey).filter(function (k) {
      return /ноутбук/i.test(dirs.categories.byKey[k].n);
    })[0] || "";
    var now = Math.floor(Date.now() / 1000);
    return {
      v: 1, l: "ru", lim: 3, u: now + 6 * 86400, pay: 1, fc: 1,
      src: ["olx", "kaspi"], sr: 0, q: [23 * 60, 8 * 60, "silent"], qm: "silent", mw: 5, mx: 10,
      st: { d: 34, w: 212, m: 38, t: now },
      subs: [
        { i: 1, s: "all", c: [astana.o, astana.k], k: "", w: [], x: ["чехол", "стекл"],
          f: null, t: 500000, p: 0, r: 1, n: 23, a: 4,
          fl: { k: "phones", c: { olx: [85], kaspi: ["200/782", "5/21/216"] },
                m: ["iphone 15 pro", "iphone 15 pro max"], f: { capacity: ["256гб"] } } },
        { i: 2, s: "kaspi", c: ["", almaty.k], k: laptops, w: ["macbook air"], x: [], f: 200000, t: 900000,
          p: 1, r: 1, n: 5, a: 190, b: 1 }
      ]
    };
  }

  // кнопка, выданная ботом до v4: город — строкой своей площадки, без статистики
  function normalize(s) {
    (s.subs || []).forEach(function (sub) {
      if (typeof sub.c === "string") sub.c = sub.s === "kaspi" ? ["", sub.c] : [sub.c, ""];
      if (!Array.isArray(sub.c)) sub.c = ["", ""];
    });
    return s;
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
    applyTheme();
    document.getElementById("dock-button").addEventListener("click", function () { if (dockAction) dockAction(); });

    if (inTelegram) {
      tg.ready();
      tg.expand();
      tg.BackButton.onClick(pop);
      tg.onEvent("themeChanged", applyTheme);
    } else if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);
    }

    Promise.all([getJSON("i18n.json"), getJSON("data/cities.json"), getJSON("data/kaspi_categories.json"),
                 getJSON("data/presets.json").catch(function () { return { items: [] }; })])
      .then(function (loaded) {
        i18n = loaded[0];
        dirs = prepareDirs(loaded[1], loaded[2]);
        dirs.presets = (loaded[3] && loaded[3].items) || [];

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
        state = normalize(loaded);
        lang = i18n[state.l] ? state.l : "ru";
        document.documentElement.lang = lang;
        stack = [{ name: "home" }];
        // названия товаров и категорий в карточках — из справочника фильтров;
        // не загрузился — карточки покажут модели и слова, остальное подгрузится позже
        var needed = state.fc && state.subs.some(function (sub) { return flScoped(sub.fl); });
        return (needed ? ensureIndex().catch(function () { return null; }) : Promise.resolve()).then(function () {
          render();
          if (state.fc) ensureIndex().catch(function () { return null; });
        });
      })
      .catch(function () {
        app.innerHTML = "";
        app.appendChild(h("p", { class: "empty", text: "Не удалось загрузить приложение. Проверьте интернет. · Қосымша жүктелмеді. Интернетті тексеріңіз." }));
      });
  }

  start();
})();
