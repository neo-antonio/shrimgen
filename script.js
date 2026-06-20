/* ==========================================================================
   SHRIMGEN — offline AI marketing copy generator
   Modules: Store · Synonyms · NLP · Similarity · Generator (real local LLM,
            see ai-engine.js) · UI
   ========================================================================== */
(function () {
  "use strict";

  /* ========================================================================
     1. STORE
  */
  const Store = (function () {
    const KEY          = "shrimgen_training_data_v3";
    const OLD_KEY_V2   = "shrimgen_training_data_v2";
    const FEEDBACK_KEY = "shrimgen_feedback_v1";

    /* --- helpers --- */
    function loadData() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) return JSON.parse(raw);
        return migrateV2() || [];
      } catch (e) { return []; }
    }
    function saveData(d) { localStorage.setItem(KEY, JSON.stringify(d)); }

    function migrateV2() {
      try {
        const raw = localStorage.getItem(OLD_KEY_V2);
        if (!raw) return null;
        const old = JSON.parse(raw);
        if (!Array.isArray(old)) return null;
        const m = old.map(r => ({
          id: r.id || uid(), productType: (r.product || "").trim(),
          event: "", audience: "", style: r.style || "Generic",
          caption: (r.caption || "").trim(), createdAt: r.createdAt || Date.now()
        }));
        saveData(m); return m;
      } catch (e) { return null; }
    }

    function uid() { return "ex_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

    function toRecord(input) {
      return {
        id:          input.id || uid(),
        productType: (input.productType || "").trim(),
        event:       (input.event       || "").trim(),
        audience:    (input.audience    || "").trim(),
        style:       input.style || "Generic",
        caption:     (input.caption     || "").trim(),
        createdAt:   input.createdAt    || Date.now()
      };
    }

    /* --- feedback --- */
    function loadFeedback() {
      try { const r = localStorage.getItem(FEEDBACK_KEY); return r ? JSON.parse(r) : []; }
      catch (e) { return []; }
    }
    function saveFeedbackData(d) { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(d)); }

    let data     = loadData();
    let feedback = loadFeedback();

    return {
      /* training examples */
      all()    { return data; },
      add(input) {
        const rec = toRecord(input); data.push(rec); saveData(data); return rec;
      },
      addBulk(productType, event, audience, style, lines) {
        const recs = lines.map(l => toRecord({ productType, event, audience, style, caption: l }));
        data = data.concat(recs); saveData(data); return recs;
      },
      update(id, input) {
        const i = data.findIndex(d => d.id === id);
        if (i === -1) return null;
        data[i] = Object.assign({}, data[i], toRecord(Object.assign({}, data[i], input)));
        saveData(data); return data[i];
      },
      remove(id)    { data = data.filter(d => d.id !== id); saveData(data); },
      clear()       { data = []; saveData(data); },
      replaceAll(n) { data = n.map(toRecord); saveData(data); return data; },

      /* feedback */
      addFeedback(text, liked, meta) {
        feedback.push({ id: uid(), text, liked, meta: meta || {}, ts: Date.now() });
        // keep last 500 entries to avoid bloat
        if (feedback.length > 500) feedback = feedback.slice(-500);
        saveFeedbackData(feedback);
      },
      getFeedback()    { return feedback; },
      getFeedbackTotals() {
        const likes    = feedback.filter(f => f.liked).length;
        const dislikes = feedback.filter(f => !f.liked).length;
        return { likes, dislikes };
      },
      /* Extract phrase sets from liked / disliked outputs for weighting */
      getLikedPhrases() {
        const s = new Set();
        feedback.filter(f => f.liked).forEach(f => {
          (f.text || "").split(/(?<=[.!?])\s+|,\s+/).forEach(p => {
            const t = p.trim().toLowerCase(); if (t.length > 5) s.add(t);
          });
        });
        return s;
      },
      getDislikedPhrases() {
        const s = new Set();
        feedback.filter(f => !f.liked).forEach(f => {
          (f.text || "").split(/(?<=[.!?])\s+|,\s+/).forEach(p => {
            const t = p.trim().toLowerCase(); if (t.length > 5) s.add(t);
          });
        });
        return s;
      }
    };
  })();

  /* ========================================================================
     2. SYNONYMS
  */
  const Synonyms = (function () {
    const MAP = {
      food:["food","feed","kibble","chow","meal"], dog:["dog","puppy","canine","pup"],
      cat:["cat","kitten","feline"], leash:["leash","lead","tether"],
      table:["table","desk","stand"], chair:["chair","seat","stool"],
      sofa:["sofa","couch","settee"], laptop:["laptop","notebook","ultrabook","computer"],
      phone:["phone","smartphone","mobile","cellphone"], shirt:["shirt","tee","top"],
      sweater:["sweater","jumper","pullover"], shoe:["shoe","sneaker","footwear"],
      bag:["bag","tote","purse","handbag"], jewelry:["jewelry","jewellery","accessory"],
      bracelet:["bracelet","bangle"], necklace:["necklace","pendant","chain"],
      flower:["flower","bouquet","floral"], candle:["candle","candles"],
      coffee:["coffee","espresso","brew"], tea:["tea"], gift:["gift","present"],
      blanket:["blanket","throw"], mug:["mug","cup"], watch:["watch","timepiece"],
      skincare:["skincare","moisturizer","lotion","serum"],
      perfume:["perfume","fragrance","cologne"],
      backpack:["backpack","rucksack","knapsack"],
      headphone:["headphone","headphones","earphone","earbuds"],
      blazer:["blazer","jacket"], wrap:["wrap","burrito","roll"],
      steak:["steak","beefsteak"], platter:["platter","tray","spread"]
    };
    const REVERSE = {};
    Object.keys(MAP).forEach(k => MAP[k].forEach(v => { REVERSE[v] = k; }));

    function stem(w) {
      if (w.length <= 4) return w;
      if (w.endsWith("ies"))                      return w.slice(0,-3)+"y";
      if (w.endsWith("es") && w.length > 5)       return w.slice(0,-2);
      if (w.endsWith("s")  && !w.endsWith("ss"))  return w.slice(0,-1);
      if (w.endsWith("ing") && w.length > 6)      return w.slice(0,-3);
      if (w.endsWith("ed")  && w.length > 5)      return w.slice(0,-2);
      return w;
    }
    function expand(token) {
      const out = new Set([token]); const st = stem(token); out.add(st);
      const canon = REVERSE[token] || REVERSE[st];
      if (canon) { out.add(canon); MAP[canon].forEach(v => out.add(stem(v))); }
      return Array.from(out);
    }
    return { expand, stem };
  })();

  /* ========================================================================
     3. NLP
  */
  const NLP = (function () {
    const STOP = new Set([
      "a","an","the","and","or","but","for","with","of","to","in","on","at",
      "is","are","was","were","be","been","being","it","its","this","that",
      "your","you","our","we","i","he","she","they","them","his","her",
      "from","by","as","into","than","then","so","if","not","no","yes",
      "will","just","get","got","up","out","about","over","again","more",
      "very","can","do","does","did","has","have","had","my","their"
    ]);

    function tokenize(t) {
      return (t||"").toLowerCase().replace(/[^a-z0-9'\s]/g," ").split(/\s+/).filter(Boolean);
    }
    function keywords(t) { return tokenize(t).filter(w => !STOP.has(w) && w.length > 2); }
    function expandedKeywords(t) {
      const out = []; keywords(t).forEach(w => out.push(...Synonyms.expand(w))); return out;
    }
    function corpusFrequency(examples) {
      const freq = {};
      examples.forEach(ex => {
        keywords([ex.productType,ex.event,ex.audience,ex.caption].filter(Boolean).join(" "))
          .forEach(w => { freq[w] = (freq[w]||0)+1; });
      });
      return freq;
    }
    function topKeywords(examples, n) {
      return Object.entries(corpusFrequency(examples)).sort((a,b)=>b[1]-a[1]).slice(0,n);
    }
    function phrases(t) {
      return (t||"").split(/(?<=[.!?])\s+|,\s+/).map(p=>p.trim()).filter(p=>p.length>0);
    }
    function splitIntoTrainingLines(bulk) {
      const out = [];
      (bulk||"").split(/\r?\n/).forEach(line => {
        const t = line.trim(); if (!t) return;
        if (t.length > 140) phrases(t).forEach(p => { if (p) out.push(p); });
        else out.push(t);
      });
      return out.filter(l => l.length > 0);
    }
    return { tokenize, keywords, expandedKeywords, corpusFrequency, topKeywords, phrases, splitIntoTrainingLines, STOP };
  })();

  /* ========================================================================
     4. SIMILARITY
  */
  const Similarity = (function () {
    const MIN_MATCH = 0.22;

    function vec(words) { const v={}; words.forEach(w=>{v[w]=(v[w]||0)+1;}); return v; }
    function cosine(a, b) {
      const keys = new Set([...Object.keys(a),...Object.keys(b)]);
      let dot=0,ma=0,mb=0;
      keys.forEach(k=>{ const av=a[k]||0,bv=b[k]||0; dot+=av*bv; ma+=av*av; mb+=bv*bv; });
      return (ma===0||mb===0) ? 0 : dot/(Math.sqrt(ma)*Math.sqrt(mb));
    }
    function fieldScore(qt, et) {
      if (!qt||!et) return 0;
      const qw = NLP.expandedKeywords(qt), ew = NLP.expandedKeywords(et);
      if (!qw.length||!ew.length) return 0;
      let base = cosine(vec(qw),vec(ew));
      if (qt.trim().toLowerCase()===et.trim().toLowerCase()) base = Math.max(base,0.97);
      return Math.min(1,base);
    }
    function score(query, example) {
      let base = 0;
      if (example.productType) {
        base = fieldScore(query.productType, example.productType);
      } else if (example.event) {
        if (!query.event) return 0;
        base = fieldScore(query.event, example.event);
      } else return 0;

      if (base < MIN_MATCH) return 0;

      const styleBonus    = (query.tone && example.style &&
        query.tone.toLowerCase()===example.style.toLowerCase()) ? 0.12 : 0;
      const audienceBonus = (query.audience && example.audience)
        ? fieldScore(query.audience, example.audience) * 0.10 : 0;

      return Math.min(1, base * 0.82 + styleBonus + audienceBonus);
    }
    function rank(query, examples) {
      return examples.map(ex=>({example:ex,score:score(query,ex)}))
        .sort((a,b)=>b.score-a.score);
    }
    return { score, rank, MIN_MATCH };
  })();

  /* ========================================================================
     5. GENERATOR
  */
  const Generator = (function () {

    /* ---------- small text utilities (kept from the old engine) ---------- */
    function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
    function cleanup(t) {
      return t.replace(/\s+/g," ").replace(/\s+([.,!?])/g,"$1").replace(/\.{2,}/g,".").trim();
    }
    function stripTrailingPunct(t) { return t.replace(/[.,!?;:]+\s*$/,"").trim(); }
    function capitalSentences(t) { return t.replace(/(^\s*|[.!?]\s+)([a-z])/g,(m,l,c)=>l+c.toUpperCase()); }
    function lowerFirst(s) { return s ? s[0].toLowerCase()+s.slice(1) : s; }
    function escRe(s)      { return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
    function endsWithEmoji(t) { return /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\s*$/u.test(t); }

    function buildProductLabel(query) {
      const name = query.mentionBrand ? query.productName : "";
      const type = query.mentionType  ? query.productType : "";
      if (name && type) return Math.random()<0.7 ? `${name} ${type}` : name;
      return name || type || query.productType || query.productName || "this product";
    }
    /* Best-effort safety net: if the model forgot to mention something the
       checklist asked for, splice it in rather than re-running generation. */
    function ensureProductMention(text, label) {
      if (!label) return text;
      if (new RegExp(escRe(label),"i").test(text)) return text;
      return Math.random()<0.85 ? `${label} — ${lowerFirst(text)}` : text;
    }
    function ensureClauseMention(text, label, joinWord, charLimit) {
      if (!label) return text;
      if (new RegExp(escRe(label),"i").test(text)) return text;
      const clause = `${joinWord} ${label}`;
      const candidate = cleanup(text.replace(/[.!?]\s*$/,"") + ", " + lowerFirst(clause) + ".");
      return candidate.length <= charLimit + 25 ? candidate : text;
    }

    /** Trim text to fit within `limit` chars, dropping whole sentences first,
        falling back to a clean word-boundary cut. Never uses "…". */
    function trimToLimit(text, limit) {
      if (text.length <= limit) return text;
      const sentences = text.split(/(?<=[.!?])\s+/);
      let result = "";
      for (const s of sentences) {
        const candidate = result ? result+" "+s : s;
        if (candidate.length <= limit) result = candidate;
        else break;
      }
      if (result) return result.trim();
      let t = text.slice(0, limit).replace(/\s+\S*$/,"").trim();
      if (!t) t = text.slice(0, limit).trim();
      if (!/[.!?]$/.test(t)) t += ".";
      return t;
    }
    function maybeAddPeriod(text, charLimit) {
      if (/[.!?]$/.test(text) || endsWithEmoji(text)) return text;
      if (charLimit <= 40) return text;
      if (text.trim().split(/\s+/).length < 5) return text;
      return text + ".";
    }

    /* ---------- prompt construction for the local LLM ---------- */
    function buildSystemPrompt(query) {
      return [
        "You are a senior advertising copywriter who writes short, punchy marketing copy.",
        `Write in a ${query.tone.toLowerCase()} tone.`,
        `The reply must be ${query.charLimit} characters or fewer in total, counting every character including spaces and punctuation.`,
        "Reply with ONLY the final ad copy itself — no quotation marks, no markdown, no labels like \"Option:\", no explanations, and no alternates."
      ].join(" ");
    }

    function buildUserPrompt(query, productLabel, fewShot, likedPhrases, dislikedPhrases) {
      const lines = [];
      lines.push(`Write one piece of marketing copy about: ${productLabel}.`);
      if (query.audience) lines.push(`Audience: ${query.audience}.`);
      if (query.event)    lines.push(`Occasion / campaign: ${query.event}.`);

      const must = [];
      if (query.mentionBrand    && query.productName) must.push(`the name "${query.productName}"`);
      if (query.mentionType     && query.productType) must.push(`the product type "${query.productType}"`);
      if (query.mentionAudience && query.audience)     must.push(`the audience "${query.audience}"`);
      if (query.mentionEvent    && query.event)        must.push(`the occasion "${query.event}"`);
      if (must.length) lines.push(`The copy must clearly mention ${must.join(" and ")}.`);

      if (fewShot.length) {
        lines.push("Match the voice of this brand's past writing (don't copy these, just match the style):");
        fewShot.forEach(s => lines.push(`- "${s}"`));
      }
      if (likedPhrases && likedPhrases.length) {
        lines.push(`Readers have responded well to phrasing like: "${pick(likedPhrases)}".`);
      }
      if (dislikedPhrases && dislikedPhrases.length) {
        lines.push(`Avoid phrasing similar to: "${pick(dislikedPhrases)}".`);
      }
      lines.push(`Stay at or under ${query.charLimit} characters.`);
      return lines.join("\n");
    }

    function estimateMaxTokens(charLimit) {
      // ~1 token ≈ 2.5–4 chars for English ad copy; pad generously since
      // trimToLimit() enforces the hard character cap afterward anyway.
      return Math.max(24, Math.min(220, Math.ceil(charLimit/2.4)));
    }

    /* ---------- one generation pass through the local LLM ---------- */
    async function generateOne(query, productLabel, fewShot, likedPhrases, dislikedPhrases, onProgress) {
      if (!window.AIEngine) throw new Error("AI engine not loaded");

      const systemPrompt = buildSystemPrompt(query);
      const userPrompt    = buildUserPrompt(query, productLabel, fewShot, likedPhrases, dislikedPhrases);
      const temperature   = 0.35 + (query.creativity/10)*0.85; // creativity 1→~0.44, 10→~1.2

      let text = await window.AIEngine.generateOne({
        systemPrompt, userPrompt,
        maxNewTokens: estimateMaxTokens(query.charLimit),
        temperature,
        onProgress
      });

      text = text.replace(/^["“'`]+|["”'`]+$/g,"").trim();
      text = cleanup(text);
      text = capitalSentences(text);
      text = ensureProductMention(text, (query.mentionBrand||query.mentionType) ? productLabel : "");
      text = ensureClauseMention(text, query.mentionAudience ? query.audience : "", "for",  query.charLimit);
      text = ensureClauseMention(text, query.mentionEvent    ? query.event    : "", "this", query.charLimit);
      if (text.length > query.charLimit) text = trimToLimit(text, query.charLimit);
      text = maybeAddPeriod(text, query.charLimit);
      return text;
    }

    /* ---------- training-set match info (drives the confidence gauge) ---------- */
    function matchInfo(query, examples) {
      const ranked   = Similarity.rank(query, examples);
      const matched  = ranked.filter(r => r.score > 0);
      const hasMatch = matched.length > 0;
      const topScore = hasMatch ? matched[0].score : 0;
      const confidence = hasMatch ? Math.min(1, topScore + Math.min(0.1, examples.length/300)) : 0;
      return {
        confidence,
        topMatch: hasMatch ? matched[0].example : null,
        ranked:   matched.slice(0,5),
        matched
      };
    }

    /**
     * Generate `query.count` variations, one at a time, calling
     * opts.onCardReady(text, index) as each completes and opts.onProgress(p)
     * with model-loading progress events (only fires meaningfully on the
     * very first generation, while the model downloads/initializes).
     */
    async function generate(query, examples, opts) {
      opts = opts || {};
      const info = matchInfo(query, examples);
      const productLabel = buildProductLabel(query);
      const fewShot = info.matched.slice(0,3).map(r => r.example.caption).filter(Boolean);
      const liked    = Array.from(Store.getLikedPhrases());
      const disliked = Array.from(Store.getDislikedPhrases());

      const seen = new Set();
      const variations = [];
      for (let i=0; i<query.count; i++) {
        let text = "", attempts = 0;
        do {
          text = await generateOne(query, productLabel, fewShot, liked, disliked, i===0 ? opts.onProgress : null);
          attempts++;
        } while (seen.has(text.toLowerCase()) && attempts < 3 && text);
        seen.add(text.toLowerCase());
        variations.push(text);
        if (opts.onCardReady) opts.onCardReady(text, i);
      }
      return variations;
    }

    return { generate, matchInfo };
  })();

  /* ========================================================================
     7. UI
  */
  const UI = (function () {
    const $  = sel => document.querySelector(sel);
    const $$ = sel => Array.from(document.querySelectorAll(sel));

    let editingId = null;

    /* ---------- toast ---------- */
    function toast(msg) {
      const el=$("#toast"); el.textContent=msg; el.classList.add("show");
      clearTimeout(toast._t); toast._t=setTimeout(()=>el.classList.remove("show"),2200);
    }

    /* ---------- tabs ---------- */
    function initTabs() {
      const btns=[...$$(".tab-btn")];
      const panels={"training":$("#tab-training"),"generate":$("#tab-generate")};
      function activate(tab) {
        btns.forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
        Object.entries(panels).forEach(([k,p])=>{
          const on=k===tab;
          p.hidden=!on;
          p.classList.toggle("active-tab",on);
        });
      }
      btns.forEach(b=>b.addEventListener("click",()=>activate(b.dataset.tab)));
      activate("training");
    }

    /* ---------- tooltips ---------- */
    function initTooltips() {
      $$(".tooltip-wrap").forEach(wrap=>{
        const icon=wrap.querySelector(".tooltip-icon");
        if (!icon) return;
        icon.addEventListener("click",e=>{
          e.stopPropagation();
          const was=wrap.classList.contains("open");
          $$(".tooltip-wrap.open").forEach(w=>w.classList.remove("open"));
          if (!was) wrap.classList.add("open");
        });
      });
      document.addEventListener("click",()=>$$(".tooltip-wrap.open").forEach(w=>w.classList.remove("open")));
    }

    /* ---------- asset specs modal ---------- */
    function initAssetSpecsModal() {
      const modal=$("#assetSpecsModal"), openBtn=$("#assetSpecsBtn"),
            closeBtn=$("#assetSpecsClose"), inp=$("#charLimitInput");
      if (!modal||!openBtn) return;
      openBtn.addEventListener("click",()=>{ modal.hidden=false; closeBtn.focus(); });
      closeBtn.addEventListener("click",()=>{ modal.hidden=true; openBtn.focus(); });
      modal.addEventListener("click",e=>{ if (e.target===modal){ modal.hidden=true; openBtn.focus(); }});
      document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&!modal.hidden){ modal.hidden=true; openBtn.focus(); }});
      $$(".specs-table tbody tr[data-limit]").forEach(row=>{
        row.addEventListener("click",()=>{
          const lim=parseInt(row.dataset.limit,10); if(isNaN(lim)||!inp) return;
          inp.value=Math.max(15,Math.min(750,Math.round(lim/5)*5));
          toast(`Character limit set to ${inp.value}.`);
          modal.hidden=true; inp.focus();
        });
      });
    }

    /* ---------- char limit snap ---------- */
    function initCharLimit() {
      const inp=$("#charLimitInput"); if(!inp) return;
      inp.addEventListener("change",()=>{
        let v=parseInt(inp.value,10)||125;
        v=Math.round(v/5)*5; v=Math.max(15,Math.min(750,v)); inp.value=v;
      });
    }

    /* ---------- stats ---------- */
    function renderStats() {
      const data=Store.all(); const freq=NLP.corpusFrequency(data);
      const statEx=$("#statExamples"), statKw=$("#statKeywords");
      if(statEx) statEx.textContent=data.length+" examples";
      if(statKw) statKw.textContent=Object.keys(freq).length+" keywords";

      const top=NLP.topKeywords(data,14); const cloud=$("#keywordCloud"); if(!cloud) return;
      cloud.innerHTML="";
      if(!top.length){ cloud.innerHTML='<span class="empty-note">No keywords learned yet.</span>'; return; }
      top.forEach(([w,c])=>{ const t=document.createElement("span"); t.className="kw-tag"; t.textContent=`${w} · ${c}`; cloud.appendChild(t); });
    }

    function renderFeedbackTally() {
      const el=$("#feedbackTally"); if(!el) return;
      const {likes,dislikes}=Store.getFeedbackTotals();
      if(!likes && !dislikes){ el.innerHTML=""; return; }
      el.innerHTML=`
        <div class="feedback-tally-row"><span>👍</span><span>${likes} liked</span></div>
        <div class="feedback-tally-row"><span>👎</span><span>${dislikes} disliked</span></div>
      `;
    }

    /* ---------- training list ---------- */
    function renderExamples(filter) {
      const list=$("#exampleList"); list.innerHTML="";
      let data=Store.all().slice().sort((a,b)=>b.createdAt-a.createdAt);
      if(filter){ const f=filter.toLowerCase(); data=data.filter(ex=>[ex.productType,ex.event,ex.audience,ex.style,ex.caption].join(" ").toLowerCase().includes(f)); }
      if(!data.length){ list.innerHTML='<li class="empty-note">No examples found.</li>'; return; }
      data.forEach(ex=>{
        const li=document.createElement("li"); li.className="example-item";
        const matchLabel = ex.productType?"Product Type":(ex.event?"Event":"—");
        const matchValue = ex.productType||ex.event||"(unspecified)";
        li.innerHTML=`
          <div class="example-item-top">
            <span class="example-item-product"></span>
            <span class="example-item-style"></span>
          </div>
          <p class="example-item-meta">
            <span class="example-item-matchtag"></span>
          </p>
          <p class="example-item-caption"></p>
          <div class="example-item-actions">
            <button type="button" class="edit">Edit</button>
            <button type="button" class="del">Delete</button>
          </div>`;
        li.querySelector(".example-item-product").textContent=matchValue;
        li.querySelector(".example-item-style").textContent=ex.style;
        const meta=li.querySelector(".example-item-meta");
        const tag=document.createElement("span"); tag.className="example-item-matchtag"; tag.textContent=`Matches by: ${matchLabel}`;
        meta.appendChild(tag);
        if(ex.audience){ const a=document.createElement("span"); a.className="example-item-audience"; a.textContent=ex.audience; meta.appendChild(a); }
        li.querySelector(".example-item-caption").textContent=ex.caption;
        li.querySelector(".edit").addEventListener("click",()=>startEdit(ex));
        li.querySelector(".del").addEventListener("click",()=>{
          if(confirm("Delete this training example?")){ Store.remove(ex.id); refreshTrainingUI(); toast("Example deleted."); }
        });
        list.appendChild(li);
      });
    }

    function refreshTrainingUI() { renderExamples($("#searchExamples").value); renderStats(); }

    function startEdit(ex) {
      editingId=ex.id;
      $("#tProductType").value=ex.productType||"";
      $("#tEvent").value=ex.event||"";
      $("#tAudience").value=ex.audience||"";
      $("#tStyle").value=ex.style;
      $("#tBulkText").value=ex.caption;
      $("#saveExampleBtn").textContent="Save changes";
      $("#cancelEditBtn").hidden=false;
      $("#tProductType").focus();
    }

    function resetForm() {
      editingId=null; $("#trainingForm").reset();
      $("#saveExampleBtn").textContent="Add"; $("#cancelEditBtn").hidden=true;
    }

    function bindTrainingForm() {
      /* mutual exclusivity: product type vs event */
      $("#tProductType").addEventListener("input",e=>{ if(e.target.value.trim()) $("#tEvent").value=""; });
      $("#tEvent").addEventListener("input",e=>{ if(e.target.value.trim()) $("#tProductType").value=""; });

      $("#trainingForm").addEventListener("submit",e=>{
        e.preventDefault();
        const productType=$("#tProductType").value.trim();
        const event=$("#tEvent").value.trim();
        const audience=$("#tAudience").value.trim();
        const style=$("#tStyle").value;
        const bulkText=$("#tBulkText").value;
        if(!productType&&!event){ alert("Fill in either Product Type or Event before saving."); return; }
        if(productType&&event){ alert("Use Product Type or Event, not both."); return; }
        if(!bulkText.trim()) return;
        if(editingId){
          Store.update(editingId,{productType,event,audience,style,caption:bulkText});
          toast("Example updated.");
        } else {
          const lines=NLP.splitIntoTrainingLines(bulkText);
          if(!lines.length) return;
          Store.addBulk(productType,event,audience,style,lines);
          toast(`Added ${lines.length} example${lines.length>1?"s":""}.`);
        }
        resetForm(); refreshTrainingUI();
      });

      $("#cancelEditBtn").addEventListener("click",resetForm);
      $("#searchExamples").addEventListener("input",e=>renderExamples(e.target.value));
    }

    /* ---------- import/export/clear ---------- */
    function bindDataTools() {
      $("#exportBtn").addEventListener("click",()=>{
        const blob=new Blob([JSON.stringify(Store.all(),null,2)],{type:"application/json"});
        const url=URL.createObjectURL(blob); const a=document.createElement("a");
        a.href=url; a.download="shrimgen-training-data.json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        toast("Training data exported.");
      });
      $("#importBtn").addEventListener("click",()=>$("#importFile").click());
      $("#importFile").addEventListener("change",e=>{
        const file=e.target.files[0]; if(!file) return;
        const reader=new FileReader();
        reader.onload=()=>{
          try {
            const parsed=JSON.parse(reader.result);
            if(!Array.isArray(parsed)) throw new Error("JSON must be an array.");
            const valid=parsed.map(p=>({
              productType:p.productType||(p.event?"":p.product||""),
              event:p.event||"", audience:p.audience||"", style:p.style||"Generic", caption:p.caption
            })).filter(p=>(p.productType||p.event)&&p.caption);
            if(!valid.length) throw new Error("No valid examples found.");
            Store.replaceAll(Store.all().concat(valid)); refreshTrainingUI(); toast(`Imported ${valid.length} example(s).`);
          } catch(err){ alert("Import failed: "+err.message); }
          e.target.value="";
        };
        reader.readAsText(file);
      });
      $("#clearBtn").addEventListener("click",()=>{
        if(confirm("Delete all training examples?")){ Store.clear(); refreshTrainingUI(); toast("Training data cleared."); }
      });
      const csvBtn=$("#importCsvBtn");
      if(csvBtn) csvBtn.addEventListener("click",()=>toast("CSV import coming soon."));
    }

    /* ---------- generation ---------- */
    function bindPromptForm() {
      $("#creativitySlider").addEventListener("input",e=>{ $("#creativityVal").textContent=e.target.value; });
      $("#promptForm").addEventListener("submit", async e=>{
        e.preventDefault();
        const raw=parseInt($("#charLimitInput").value,10)||125;
        const charLimit=Math.max(15,Math.min(750,Math.round(raw/5)*5));
        const query={
          productName: $("#pProductName").value.trim(),
          productType: $("#pProductType").value.trim(),
          event:       $("#pEvent").value.trim(),
          audience:    $("#pAudience").value.trim(),
          tone:        $$('input[name="tone"]:checked')[0].value,
          charLimit,
          creativity:  parseInt($("#creativitySlider").value,10),
          count:       Math.max(1,Math.min(6,parseInt($("#variationCount").value,10)||3)),
          mentionBrand:    $("#mentionBrand")?.checked    ?? true,
          mentionType:     $("#mentionType")?.checked     ?? true,
          mentionAudience: $("#mentionAudience")?.checked ?? false,
          mentionEvent:    $("#mentionEvent")?.checked    ?? false
        };

        if (!window.AIEngine) {
          toast("AI engine failed to load — check your connection and reload the page.");
          return;
        }

        const examples = Store.all();
        const info = Generator.matchInfo(query, examples);
        renderMatchInfo(query, info);

        const cards = prepareOutputCards(query.count);
        const genBtn = $(".btn-generate");
        const originalLabel = genBtn.textContent;
        genBtn.disabled = true;
        genBtn.textContent = "Generating…";

        try {
          await Generator.generate(query, examples, {
            onProgress: p => updateModelStatus(p),
            onCardReady: (text, idx) => { clearModelStatus(); fillCard(cards[idx], text, query); }
          });
        } catch (err) {
          console.error("[ShrimGen] generation failed:", err);
          toast("Generation failed — see the browser console for details.");
        } finally {
          genBtn.disabled = false;
          genBtn.textContent = originalLabel;
          clearModelStatus();
        }
      });
    }

    /* ---------- model load/download status ---------- */
    function updateModelStatus(p) {
      const el = $("#modelStatus");
      const bar = $("#downloadBar");
      const barText = $("#downloadBarText");
      const barFill = $("#downloadBarFill");
      const barPct  = $("#downloadBarPct");
      if (!p) return;
      if (p.status === "progress" && typeof p.progress === "number") {
        el.hidden = false;
        el.textContent = `Loading AI model — one-time download (cached after this)… ${Math.round(p.progress)}%`;
        if (bar) {
          bar.hidden = false;
          if (barText) barText.textContent = "Downloading resources";
          const pct = Math.round(p.progress);
          if (barFill) barFill.style.width = pct + "%";
          if (barPct)  barPct.textContent  = pct + "%";
        }
      } else if (p.status === "initiate" || p.status === "download") {
        el.hidden = false;
        el.textContent = "Preparing AI model…";
        if (bar) {
          bar.hidden = false;
          if (barText) barText.textContent = "Downloading resources";
          if (barFill) barFill.style.width = "0%";
          if (barPct)  barPct.textContent  = "";
        }
      } else if (p.status === "ready" || p.status === "done") {
        clearModelStatus();
      }
    }
    function clearModelStatus() {
      const el = $("#modelStatus");
      el.hidden = true; el.textContent = "";
      const bar = $("#downloadBar");
      if (bar) bar.hidden = true;
      syncModelDownloadButton();
    }
    function syncModelDownloadButton() {
      if (!(window.AIEngine && window.AIEngine.isReady && window.AIEngine.isReady())) return;
      const btn = $("#modelDownloadBtn");
      const status = $("#modelDownloadStatus");
      const track = $("#modelDownloadTrack");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "Downloaded";
      if (status) { status.textContent = "Ready — running fully offline"; status.classList.add("ready"); }
      if (track) track.hidden = true;
    }

    /* ---------- gauge ---------- */
    function renderGauge(score) {
      const pct=Math.round(score*100);
      const offset=283-(283*Math.min(score,1));
      $("#gaugeFill").style.strokeDashoffset=offset;
      $("#confidenceNum").textContent=pct+"%";
      const fill=$("#gaugeFill");
      fill.style.stroke = pct>=66?"var(--amber)":pct>=33?"var(--teal)":"var(--red)";
    }

    /* ---------- training-set match info (shown immediately, before generation finishes) ---------- */
    function renderMatchInfo(query, info) {
      renderGauge(info.confidence);
      renderFeedbackTally();

      const matchInfoEl=$("#matchInfo");
      if(info.topMatch){
        const pct=Math.round(info.confidence*100);
        const ml=info.topMatch.productType?"Product Type":"Event";
        const mv=info.topMatch.productType||info.topMatch.event;
        matchInfoEl.innerHTML=`
          Closest training match (${esc(ml)}): <strong>${esc(mv)}</strong>
          (${esc(info.topMatch.style)}) — training-set confidence <strong>${pct}%</strong>.
          Drawing style from <strong>${info.ranked.length}</strong> example(s); copy itself is written by the local LLM.
        `;
      } else {
        matchInfoEl.innerHTML=`<p class="placeholder-text">No close training match — the AI will write from the brief alone.</p>`;
      }
    }

    /* ---------- typing animation ---------- */
    function typeWords(el, text, speed) {
      speed = speed || 55;
      return new Promise(resolve => {
        const tokens = text.split(/(\s+)/).filter(t => t.length);
        let i = 0;
        el.textContent = "";
        el.classList.add("typing");
        (function step() {
          if (i < tokens.length) {
            el.textContent += tokens[i];
            i++;
            setTimeout(step, /^\s+$/.test(tokens[i-1]) ? 0 : speed);
          } else {
            el.classList.remove("typing");
            resolve();
          }
        })();
      });
    }

    /* ---------- build empty placeholder cards immediately, before the LLM has written anything ---------- */
    function prepareOutputCards(count) {
      const list=$("#outputList"); list.innerHTML="";
      const cards=[];
      for (let idx=0; idx<count; idx++) {
        const card=document.createElement("div"); card.className="output-card";
        card.style.animationDelay=(idx*120)+"ms";
        card.innerHTML=`
          <p class="thinking"></p>
          <div class="output-card-foot">
            <span class="output-card-tag">Writing…</span>
            <div class="output-card-actions">
              <span class="model-badge">ShrimGen v1.0</span>
              <button type="button" class="feedback-btn like-btn" title="Good output"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg></button>
              <button type="button" class="feedback-btn dislike-btn" title="Poor output"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg></button>
              <button type="button" class="copy-btn">Copy</button>
            </div>
          </div>`;
        list.appendChild(card);
        cards.push({
          card,
          pEl:   card.querySelector("p"),
          tagEl: card.querySelector(".output-card-tag"),
          footEl: card.querySelector(".output-card-foot"),
          likeBtn: card.querySelector(".like-btn"),
          dislikeBtn: card.querySelector(".dislike-btn"),
          copyBtn: card.querySelector(".copy-btn")
        });
      }
      return cards;
    }

    /* ---------- fill a placeholder card once the LLM has produced its text ---------- */
    function fillCard(ref, text, query) {
      if (!ref) return;
      ref.pEl.classList.remove("thinking");
      ref.tagEl.textContent = `${query.tone} · ${text.length} / ${query.charLimit} chars`;

      const device = window.AIEngine && window.AIEngine.getDevice ? window.AIEngine.getDevice() : null;
      const badge = ref.footEl.querySelector(".model-badge");
      if (badge && device) badge.textContent = `ShrimGen v1.0 · ${device==="webgpu"?"GPU":"CPU"}`;

      typeWords(ref.pEl, text).then(()=>{ ref.footEl.classList.add("visible"); });

      let voted=null;
      function applyVote(liked) {
        Store.addFeedback(text, liked, { tone:query.tone, productType:query.productType, audience:query.audience, charLimit:query.charLimit });
        voted=liked;
        ref.likeBtn.classList.toggle("voted-like", liked===true);
        ref.likeBtn.classList.remove("voted-dislike");
        ref.dislikeBtn.classList.toggle("voted-dislike", liked===false);
        ref.dislikeBtn.classList.remove("voted-like");
        renderFeedbackTally();
        toast(liked?"Marked as good — future prompts will lean toward this phrasing.":"Marked as poor — future prompts will steer away from this phrasing.");
      }
      ref.likeBtn.addEventListener("click",   ()=>applyVote(true));
      ref.dislikeBtn.addEventListener("click", ()=>applyVote(false));
      ref.copyBtn.addEventListener("click",()=>{ copyText(text); toast("Copied to clipboard."); });
    }

    function copyText(text) {
      if(navigator.clipboard&&navigator.clipboard.writeText)
        navigator.clipboard.writeText(text).catch(()=>fallbackCopy(text));
      else fallbackCopy(text);
    }
    function fallbackCopy(text) {
      const ta=document.createElement("textarea"); ta.value=text;
      ta.style.cssText="position:fixed;opacity:0"; document.body.appendChild(ta);
      ta.select(); try{document.execCommand("copy");}catch(e){}
      document.body.removeChild(ta);
    }
    function esc(str) {
      const d=document.createElement("div"); d.textContent=str; return d.innerHTML;
    }

    /* ---------- inline model download control ---------- */
    function bindModelDownload() {
      const btn    = $("#modelDownloadBtn");
      const status = $("#modelDownloadStatus");
      const track  = $("#modelDownloadTrack");
      const fill   = $("#modelDownloadFill");
      if (!btn) return;

      function setReady() {
        btn.disabled = true;
        btn.textContent = "Downloaded";
        status.textContent = "Ready — running fully offline";
        status.classList.add("ready");
        track.hidden = true;
      }

      if (window.AIEngine && window.AIEngine.isReady && window.AIEngine.isReady()) {
        setReady();
      }

      btn.addEventListener("click", () => {
        if (!window.AIEngine || !window.AIEngine.preload) {
          toast("AI engine hasn't loaded yet — check your connection and try again in a moment.");
          console.error("[ShrimGen] window.AIEngine is not available. The ai-engine.js module may have failed to load (check the browser console/network tab for a blocked or failed import from cdn.jsdelivr.net).");
          return;
        }
        btn.disabled = true;
        btn.textContent = "Downloading…";
        status.textContent = "Starting download…";
        status.classList.remove("ready");
        track.hidden = false;
        fill.style.width = "0%";

        window.AIEngine.preload(p => {
          if (!p) return;
          if (p.status === "progress" && typeof p.progress === "number") {
            const pct = Math.round(p.progress);
            fill.style.width = pct + "%";
            status.textContent = `Downloading… ${pct}%`;
          } else if (p.status === "initiate" || p.status === "download") {
            status.textContent = "Preparing AI model…";
          }
        }).then(() => {
          setReady();
        }).catch(err => {
          console.error("[ShrimGen] model download failed:", err);
          btn.disabled = false;
          btn.textContent = "Retry download";
          status.textContent = "Download failed — try again";
          track.hidden = true;
        });
      });
    }

    function init() {
      initTabs(); initTooltips(); initAssetSpecsModal();
      initCharLimit();
      bindTrainingForm(); bindDataTools(); bindPromptForm(); bindModelDownload();
      refreshTrainingUI(); renderFeedbackTally();
    }
    return { init };
  })();

  document.addEventListener("DOMContentLoaded", UI.init);
})();