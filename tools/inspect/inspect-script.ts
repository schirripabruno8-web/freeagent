/**
 * Struttura DOM per scrivere i selettori (`npm run inspect`).
 * PRIVACY: mai value, href, src, innerHTML, cookie, storage, ne' testo di nodi generici.
 * Il testo esce in chiaro solo per etichette/voci di menu corte (<=40 car.), altrimenti "[N chars]".
 */

export interface TreeNode {
  tag: string
  id?: string
  cls?: string[]
  role?: string
  label?: string
  data?: string[]
  vals?: Record<string, string>
  text?: string
  kids?: TreeNode[]
}

export interface DomReport {
  origin: string
  candidates: {
    input: {
      selector: string
      tag: string
      role: string | null
      placeholder: string | null
      ariaLabel: string | null
      contenteditable: string | null
    }[]
    sendButton: {
      selector: string
      classes: string[]
      ariaLabel: string | null
      type: string | null
      disabled: boolean
      svgOnly: boolean
      /** Primi caratteri del path dell'icona: cambia tra freccia di invio e quadrato di stop. */
      svgSig: string | null
    }[]
    /** Fratelli ripetuti che contengono markdown o hanno classi tipo message/assistant (servono almeno 2 scambi). */
    assistantMessage: { parent: string; childSelector: string; children: number; classes: string[]; hasPre: boolean }[]
    /** Genitori diretti di <p>/<pre> fuori da sidebar e input: di solito il contenitore del markdown, anche con un solo messaggio. */
    markdownContainers: { selector: string; classes: string[]; count: number }[]
    /** Toggle/tab/radio visibili fuori sidebar (modalita' tipo Instant/Expert, DeepThink). */
    controls: { selector: string; role: string | null; state: string | null; text: string }[]
    modelSelector: {
      triggers: { selector: string; tag: string; role: string | null; haspopup: string | null; text: string }[]
      options: { selector: string; text: string }[]
    }
    errorRegions: { selector: string; role: string | null; textChars: number }[]
  }
  loginIndicator: boolean
  /** Sotto-albero attorno alla casella di input (4 livelli sopra): contiene invio/stop. */
  composer: TreeNode | null
  /** Sotto-albero dell'ultimo messaggio di ogni gruppo: struttura di blocchi di codice, toolbar, ecc. */
  messageTrees: TreeNode[]
  tree: TreeNode
}

// Template literal: nessun backtick o "${" dentro; i backslash delle regex sono raddoppiati.
export const INSPECT_SCRIPT = `(function () {
  var MODEL_RE = /model|gpt|deepseek|qwen|gemini|flash|pro|max|kimi|glm|llama/i;
  var LOGIN_RE = /log ?in|sign ?in|accedi|登录|登入/i;
  var MSG_RE = /markdown|message|assistant|answer|response/i;
  var SAFE_RE = /^[A-Za-z0-9_-]+$/;
  var KEEP = ['data-testid', 'data-role', 'data-message-author-role'];
  // Chat titles live here: never print labels or button text from these areas.
  var SIDE = 'nav, aside, [role=navigation], [class*=sidebar], [class*=history]';
  var inSide = function (el) { return !!el.closest(SIDE); };

  var attr = function (el, n) { return el.getAttribute(n); };
  var classes = function (el) { return Array.prototype.slice.call(el.classList); };
  var safeClasses = function (el) { return classes(el).filter(function (c) { return SAFE_RE.test(c); }); };
  var ownText = function (el) {
    return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; })
      .map(function (n) { return n.textContent; }).join('').trim();
  };
  var shown = function (t, plain) { return plain && t.length <= 40 ? t : '[' + t.length + ' chars]'; };
  // Computed style: in jsdom non c'e' layout, quindi niente rect.
  var visible = function (el) {
    if (getComputedStyle(el).visibility === 'hidden') return false;
    for (var e = el; e; e = e.parentElement) {
      if (e.hidden || getComputedStyle(e).display === 'none') return false;
    }
    return true;
  };
  // Priorita': #id, [data-testid], [aria-label], tag.classi
  var suggest = function (el) {
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return '#' + el.id;
    var tid = attr(el, 'data-testid');
    if (tid && SAFE_RE.test(tid)) return '[data-testid="' + tid + '"]';
    var label = attr(el, 'aria-label');
    if (label && label.length <= 60 && !/["\\\\]/.test(label)) return '[aria-label="' + label + '"]';
    var cls = safeClasses(el).slice(0, 2).map(function (c) { return '.' + c; }).join('');
    var role = attr(el, 'role');
    if (!cls && role && SAFE_RE.test(role)) cls = '[role="' + role + '"]';
    return el.tagName.toLowerCase() + cls;
  };

  var looksLikeMessage = function (el) {
    if (el.querySelector('p, pre, ul')) return true;
    var s = attr(el, 'class') || '';
    Array.prototype.forEach.call(el.attributes, function (a) { s += ' ' + a.name; });
    return MSG_RE.test(s);
  };
  var assistantGroups = function () {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('*'), function (parent) {
      var seen = new Map();
      Array.prototype.forEach.call(parent.children, function (c) {
        if (!looksLikeMessage(c)) return;
        var key = c.tagName + '|' + classes(c).join('.') + '|' + (attr(c, 'data-message-author-role') || '');
        var g = seen.get(key);
        if (g) { g.n++; g.el = c; } else seen.set(key, { el: c, n: 1 });
      });
      seen.forEach(function (g) {
        if (g.n < 2 || inSide(g.el)) return;
        var role = attr(g.el, 'data-message-author-role');
        var child = g.el.tagName.toLowerCase() + safeClasses(g.el).map(function (c) { return '.' + c; }).join('');
        if (role && SAFE_RE.test(role)) child += '[data-message-author-role="' + role + '"]';
        out.push({ info: { parent: suggest(parent), childSelector: child, children: g.n, classes: classes(g.el), hasPre: !!g.el.querySelector('pre') }, el: g.el });
      });
    });
    return out;
  };

  var inputs = Array.prototype.filter.call(
    document.querySelectorAll('textarea, [contenteditable=true], [role=textbox]'), function (el) { return visible(el) && !inSide(el); });
  var buttons = new Set();
  inputs.forEach(function (inp) {
    var a = inp.parentElement;
    for (var i = 0; i < 3 && a; i++, a = a.parentElement) {
      Array.prototype.forEach.call(a.querySelectorAll('button, [role=button], input[type=submit]'), function (b) { if (!inSide(b)) buttons.add(b); });
    }
  });

  var triggers = Array.prototype.filter.call(document.querySelectorAll('button, [aria-haspopup], [role=combobox]'), function (el) {
    var t = el.textContent.trim();
    var named = el.tagName === 'BUTTON' && t.length <= 40 && MODEL_RE.test(t);
    return visible(el) && !inSide(el) && (el.hasAttribute('aria-haspopup') || el.getAttribute('role') === 'combobox' || named);
  }).map(function (el) {
    var t = el.textContent.trim();
    return { selector: suggest(el), tag: el.tagName.toLowerCase(), role: attr(el, 'role'), haspopup: attr(el, 'aria-haspopup'), text: shown(t, MODEL_RE.test(t)) };
  });
  var options = Array.prototype.filter.call(document.querySelectorAll('[role=option], [role=menuitem]'), function (el) { return visible(el) && !inSide(el); })
    .map(function (el) { return { selector: suggest(el), text: shown(el.textContent.trim(), true) }; });

  // Redacted structural outline. maxLevel/max bound depth and node count per call.
  var tree = function (root, maxLevel, max) {
    var budget = max;
    var node = function (el, level) {
      budget--;
      var tag = el.tagName.toLowerCase();
      var role = attr(el, 'role');
      var n = { tag: tag };
      if (el.id) n.id = el.id;
      var cls = classes(el).slice(0, 4);
      if (cls.length) n.cls = cls;
      if (role) n.role = role;
      var lab = attr(el, 'aria-label');
      var isControl = /^(button|a|input|textarea|select)$/.test(tag) || /^(button|textbox|combobox|option|menuitem)$/.test(role || '');
      if (lab) n.label = isControl && !inSide(el) && lab.length <= 40 ? lab : '[' + lab.length + ' chars]';
      var data = [], vals = {};
      Array.prototype.forEach.call(el.attributes, function (a) {
        if (a.name.indexOf('data-') === 0) data.push(a.name);
        if (KEEP.indexOf(a.name) >= 0 && a.value.length <= 40) vals[a.name] = a.value;
      });
      if (data.length) n.data = data;
      if (Object.keys(vals).length) n.vals = vals;
      var isLabel = (/^(button|option|label)$/.test(tag) || role === 'option' || role === 'menuitem') && !inSide(el);
      var txt = isLabel ? el.textContent.trim() : ownText(el);
      if (txt) n.text = shown(txt, isLabel);
      if (level < maxLevel && tag !== 'svg') {
        var kids = [];
        for (var i = 0; i < el.children.length && budget > 0; i++) {
          if (!/^(script|style|noscript)$/.test(el.children[i].tagName.toLowerCase())) kids.push(node(el.children[i], level + 1));
        }
        if (kids.length) n.kids = kids;
      }
      return n;
    };
    return node(root, 1);
  };
  var up = function (el, k) { for (var i = 0; i < k && el.parentElement; i++) el = el.parentElement; return el; };
  var groups = assistantGroups();
  var md = {};
  Array.prototype.forEach.call(document.querySelectorAll('p, pre'), function (el) {
    var par = el.parentElement;
    if (!par || inSide(el) || el.closest('textarea, [contenteditable=true], [role=alert], [role=status]') || !visible(el)) return;
    var k = suggest(par);
    md[k] = md[k] || { selector: k, classes: safeClasses(par), count: 0 };
    md[k].count++;
  });
  var controls = Array.prototype.filter.call(
    document.querySelectorAll('[role=radio], [role=tab], [role=switch], [role=checkbox], [aria-checked], [aria-selected], [aria-pressed]'),
    function (el) { return visible(el) && !inSide(el) && el.textContent.trim().length <= 40; }
  ).map(function (el) {
    var st = attr(el, 'aria-checked') || attr(el, 'aria-selected') || attr(el, 'aria-pressed');
    return { selector: suggest(el), role: attr(el, 'role'), state: st, text: shown(el.textContent.trim(), true) };
  });

  return {
    origin: location.origin,
    candidates: {
      input: inputs.map(function (el) {
        return { selector: suggest(el), tag: el.tagName.toLowerCase(), role: attr(el, 'role'), placeholder: attr(el, 'placeholder'), ariaLabel: attr(el, 'aria-label'), contenteditable: attr(el, 'contenteditable') };
      }),
      sendButton: Array.from(buttons).map(function (b) {
        var path = b.querySelector('svg path');
        return { selector: suggest(b), classes: safeClasses(b), svgSig: path ? (attr(path, 'd') || '').slice(0, 40) : null, ariaLabel: attr(b, 'aria-label'), type: attr(b, 'type'), disabled: !!b.disabled || attr(b, 'aria-disabled') === 'true', svgOnly: !!b.querySelector('svg') && !b.textContent.trim() };
      }),
      assistantMessage: groups.map(function (g) { return g.info; }),
      controls: controls,
      markdownContainers: Object.keys(md).map(function (k) { return md[k]; }).slice(0, 10),
      modelSelector: { triggers: triggers, options: options },
      errorRegions: Array.prototype.map.call(document.querySelectorAll('[role=alert], [role=status], [class*=toast], [class*=snackbar], [class*=notification]'), function (el) {
        return { selector: suggest(el), role: attr(el, 'role'), textChars: el.textContent.trim().length };
      })
    },
    loginIndicator: Array.prototype.some.call(document.querySelectorAll('input[type=password], button, a, [role=button]'), function (el) {
      if (!visible(el)) return false;
      var t = el.textContent.trim();
      return el.tagName === 'INPUT' || (t.length <= 40 && LOGIN_RE.test(t));
    }),
    composer: inputs.length ? tree(up(inputs[0], 4), 12, 200) : null,
    messageTrees: groups.slice(0, 3).map(function (g) { return tree(g.el, 10, 150); }),
    tree: tree(document.body, 16, 800)
  };
})()`
