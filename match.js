/* Правила совпадения — копия matching.py бота (phrase_ok, has_word, минус-слова).
 * Нужны приложению для блока «Что придёт»: человек видит, какие заголовки его
 * подписка пропустит, а какие отсеет. Решает всё равно бот; тест
 * tests/test_webapp.py::test_js_matcher_agrees_with_bot сверяет эту копию
 * с matching.py на общем наборе заголовков — расхождения ловятся сразу.
 */
(function (root) {
  "use strict";

  var ALNUM = /[\p{L}\p{N}]/u;
  var DIGIT = /\p{Nd}/u;

  function fold(text) {
    return String(text || "").toLowerCase().replace(/ё/g, "е");
  }

  // text[at] — начало слова: начало строки, перед ним не буква и не цифра,
  // либо переход «буква ↔ цифра» («iphone15» — «15» новое слово)
  function startsWord(text, at) {
    if (at === 0) return true;
    var before = text[at - 1], first = text[at];
    if (!ALNUM.test(before)) return true;
    return DIGIT.test(before) !== DIGIT.test(first);
  }

  // слово встречается с НАЧАЛА слова; конец не проверяется («айфон» → «айфона»)
  function hasWord(title, word) {
    if (!word) return false;
    for (var at = title.indexOf(word); at >= 0; at = title.indexOf(word, at + 1)) {
      if (startsWord(title, at)) return true;
    }
    return false;
  }

  // все слова варианта есть в заголовке, в любом порядке
  function phraseOk(title, phrase) {
    var parts = fold(phrase).split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every(function (part) { return hasWord(title, part); });
  }

  /* Проверка заголовка подпиской: {ok, word, minus}. word — сработавший вариант,
   * minus — сработавшее минус-слово (тогда ok=false). */
  function check(title, words, minus) {
    var folded = fold(title);
    var hitMinus = (minus || []).filter(function (m) { return phraseOk(folded, m); })[0];
    var hitWord = (words || []).length
      ? (words || []).filter(function (w) { return phraseOk(folded, w); })[0]
      : "";
    var matched = !(words || []).length || hitWord !== undefined;
    return { ok: matched && !hitMinus, word: hitWord || "", minus: hitMinus || "" };
  }

  var api = { fold: fold, startsWord: startsWord, hasWord: hasWord, phraseOk: phraseOk, check: check };

  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PRMatch = api;
})(this);
