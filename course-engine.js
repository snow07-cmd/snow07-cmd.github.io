/* =====================================================================
   요트핏 코스 짜기 엔진 (course-engine.js)
   - 문장 읽기(parse), 카페·식당 점수(score), 내린 뒤 일정(planAfter),
     타기 전 식사(planBefore), 미리 계산 표 찾기(lookup)
   - 사이트와 표 만드는 프로그램이 같은 엔진을 써서 결과가 항상 같아요.
   ===================================================================== */
(function (root) {
  const DICT = () => root.COURSE_DICT || {};
  const STAY = { food: 90, cafe: 90, walk: 30 };
  const DAY_END = 22 * 60;
  const hm = s => { const m = String(s || "").match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const r10 = m => Math.ceil(m / 10) * 10;
  const fmt = min => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
  const isMeal = m => (m >= 11 * 60 && m < 14 * 60) || (m >= 17 * 60 && m < 20 * 60);
  const mealLabel = m => m >= 17 * 60 ? "저녁 식사" : m >= 15 * 60 ? "식사" : "점심 식사";

  // 그 시각에 열려 있는지 (들어가는 시각 + 60분이 라스트오더·닫는 시각 안)
  function openAt(p, wd, min, stay = 40) {
    // 자료마다 닫는 시각이 다른 곳은 더 이른 시각 기준으로 (course-dict.js 의 safeClose)
    const pr = ((root.COURSE_DICT || {}).places || {})[p.name];
    if (pr && pr.safeClose && min + Math.min(stay, 60) > hm(pr.safeClose)) return false;
    if (!p.hours) return true;
    if ((p.off || []).includes(wd)) return false;
    return p.hours.some(h => {
      if (!String(h.d).includes(String(wd))) return false;
      const o = hm(h.o), c = hm(h.lo || h.c);
      return min >= o && min + Math.min(stay, 60) <= c;
    });
  }

  /* ---------- 문장 읽기 ---------- */
  const squash = t => String(t || "").replace(/\s+/g, "");
  // 띄어쓰기를 지운 글자와, 각 글자가 원래 문장 몇 번째였는지
  function packed(raw) {
    const str = String(raw || ""); let s = ""; const pos = [];
    for (let i = 0; i < str.length; i++) if (!/\s/.test(str[i])) { s += str[i]; pos.push(i); }
    return { s, pos };
  }
  // 띄어쓰기를 건너 이어 붙은 표현은 앞부분이 두 글자 이상일 때만 인정 ("여자 친구" O, "체력이약 혼자" → '약혼자' X)
  function crossOK(pk, i, len) {
    if (!pk.pos) return true;
    for (let k = 1; k < len; k++) if (pk.pos[i + k] - pk.pos[i + k - 1] > 1) return k >= 2;
    return true;
  }
  function lexList(cat) {
    const L = (DICT().lex || {})[cat] || {};
    const out = [];
    for (const v in L) if (v !== "except") for (const w of String(L[v]).split("|")) if (w) out.push([squash(w), v]);
    return out.sort((a, b) => b[0].length - a[0].length);
  }
  const _cache = {};
  const lex = cat => _cache[cat] || (_cache[cat] = lexList(cat));
  const BLANK = "\u3000";
  function maskAll(t, w, pk) {
    let from = 0, i;
    while ((i = t.indexOf(w, from)) >= 0) {
      if (crossOK(pk, i, w.length)) t = t.slice(0, i) + BLANK.repeat(w.length) + t.slice(i + w.length);
      from = i + 1;
    }
    return t;
  }
  function clean(cat, t, pk) {
    const ex = (((DICT().lex || {})[cat] || {}).except || []).map(squash).sort((a, b) => b.length - a.length);
    for (const e of ex) t = maskAll(t, e, pk);
    return t;
  }
  // 카테고리 안에서 찾은 값들 (긴 표현 먼저, 찾은 자리는 지워서 겹치지 않게)
  function findAll(cat, s) {
    const pk = typeof s === "object" ? s : { s, pos: null };
    let t = clean(cat, pk.s, pk);
    const hits = [];
    for (const [w, v] of lex(cat)) {
      let from = 0, i;
      while ((i = t.indexOf(w, from)) >= 0) {
        if (crossOK(pk, i, w.length)) { hits.push({ v, w, len: w.length, at: i }); t = t.slice(0, i) + BLANK.repeat(w.length) + t.slice(i + w.length); break; }
        from = i + 1;
      }
    }
    return hits;
  }
  const best = hits => hits.length ? hits.slice().sort((a, b) => b.len - a.len || a.at - b.at)[0] : null;
  const has = (cat, v, s) => findAll(cat, s).some(h => h.v === v);

  const PARTY_LABEL = { couple: "연인·부부", family: "가족·아이", senior: "어르신과", friends: "친구", group: "단체", solo: "혼자", pet: "반려동물" };
  const WANT_LABEL = { wine: "와인", swim: "요트 수영", private: "프라이빗", cheap: "저렴하게", photo: "사진", anniv: "기념일", propose: "프러포즈",
    quiet: "조용히", view: "바다 전망", rooftop: "테라스", dessert: "디저트", bakery: "빵", coffee: "커피 맛", beer: "맥주", night: "야경",
    walkLove: "산책", longRide: "오래 타기", shortRide: "짧게 타기", indoor: "실내 위주", work: "콘센트", quick: "빠르게", early: "이른 아침" };
  const BODY_LABEL = { sick: "멀미 걱정", pregnant: "임산부", wheel: "휠체어", stroller: "유모차·아기", walkHard: "많이 못 걸어요", water: "물이 무서워요", coldy: "추위를 타요" };

  function parse(text, now = new Date()) {
    const raw = String(text || "");
    const s = packed(raw);            // 사전 찾기용 (띄어쓰기 정보 포함)
    const sq = s.s;                   // 띄어쓰기 없는 글자 (정규식용)
    const o = { q: raw, found: [], wants: {}, body: {} };
    const hit = (k, v, label) => { o[k] = v; if (label && !o.found.includes(label)) o.found.push(label); };
    const wdNow = now.getDay();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffTo = d => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - midnight) / 864e5);
    const WD = ["일", "월", "화", "수", "목", "금", "토"];

    // 날짜: 날짜 숫자 > 요일 > 오늘·내일
    let m;
    if ((m = raw.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) {
      let d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
      if (diffTo(d) < 0) d = new Date(now.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
      hit("day", diffTo(d), `${m[1]}월 ${m[2]}일`);
    } else if (/크리스마스이브|성탄이브|크리스마스전날/.test(sq)) {
      let d = new Date(now.getFullYear(), 11, 24); if (diffTo(d) < 0) d = new Date(now.getFullYear() + 1, 11, 24);
      hit("day", diffTo(d), "크리스마스 이브");
    } else if (/크리스마스|성탄절|성탄/.test(sq)) {
      let d = new Date(now.getFullYear(), 11, 25); if (diffTo(d) < 0) d = new Date(now.getFullYear() + 1, 11, 25);
      hit("day", diffTo(d), "크리스마스");
    } else {
      const re = /(\d{1,2})\s*일(?!\s*(뒤|후|이나|정도|간|동안|째|치|에\s*한))/g; let dm;
      while ((dm = re.exec(raw))) {
        const before = raw.slice(Math.max(0, dm.index - 3), dm.index);
        if (/박\s*$|월\s*$|\d$/.test(before)) continue;
        const n = Number(dm[1]); if (n < 1 || n > 31) continue;
        let d = new Date(now.getFullYear(), now.getMonth(), n);
        if (diffTo(d) < 0) d = new Date(now.getFullYear(), now.getMonth() + 1, n);
        hit("day", diffTo(d), `${d.getMonth() + 1}월 ${d.getDate()}일`); break;
      }
    }
    if (o.day == null) {
      const wh = best(findAll("weekday", s));
      if (wh) {
        const want = Number(wh.v), wk = best(findAll("week", s));
        const mon = x => (x + 6) % 7;                        // 월요일 = 0
        let add = (want - wdNow + 7) % 7;                     // 가장 가까운 그 요일 (오늘 포함)
        if (wk && wk.v === "next") add = (7 - mon(wdNow)) + mon(want);
        if (/주말/.test(wh.w) && wdNow === 0 && !(wk && wk.v === "next")) add = 0;   // 일요일에 "주말" = 오늘
        hit("day", add, `${wk && wk.v === "next" ? "다음 주 " : ""}${/주말/.test(wh.w) && add === 0 && wdNow === 0 ? "일" : WD[want]}요일`);
      } else if (findAll("weekdayOnly", s).length) {
        const add = wdNow === 6 ? 2 : wdNow === 0 ? 1 : 0;
        hit("day", add, "평일");
      } else {
        const dh = best(findAll("day", s));
        if (dh) hit("day", Number(dh.v), ["오늘", "내일", "모레", "글피"][Number(dh.v)] || `${dh.v}일 뒤`);
      }
    }

    // 시각: 출항 시각과 '~까지(끝나는 시각)' 나누기
    const timeRe = /(오전|오후|아침|저녁|밤|새벽|낮)?\s*(\d{1,2})\s*(?:시(?!간)|:(?=\d{2}))\s*(반|(\d{1,2})\s*분?)?\s*(쯤|경|정도)?\s*(까지|전에|전까지|안에|기차|ktx|KTX|버스|비행기|출발|떠나|가야|체크인|체크아웃|에\s*(가야|떠나|출발|나가|돌아가))?/g;
    let tm;
    while ((tm = timeRe.exec(raw))) {
      let h = Number(tm[2]); const mi = tm[3] ? (/반/.test(tm[3]) ? 30 : Number(tm[4] || 0)) : 0;
      if (h > 24 || mi > 59) continue;
      const ap = tm[1];
      if ((ap === "오후" || ap === "저녁" || ap === "밤" || (ap === "낮" && h < 6) || (!ap && h < 9)) && h < 12) h += 12;
      const v = h * 60 + mi;
      if (tm[6]) { hit("endBy", v, `${fmt(v)}까지`); if (/기차|ktx|KTX|버스|비행기/.test(tm[6])) o.endTravel = true; }
      else if (o.time == null && v >= 6 * 60 && v <= 21 * 60) hit("time", v, `${fmt(v)} 출항`);
    }
    if (o.time == null && /정오/.test(sq)) hit("time", 12 * 60, "12:00 출항");

    const sl = best(findAll("slot", s));
    if (sl && sl.v === "night") { hit("slot", "sunset", "노을·밤"); o.nightWalk = true; }
    else if (sl) hit("slot", sl.v, { sunset: "노을", am: "오전", pm: "오후" }[sl.v]);

    // 함께 가는 사람
    const ph = findAll("party", s);
    const kinds = new Set(ph.map(h => h.v));
    if (kinds.has("senior")) o.senior = true;
    if (kinds.has("family")) o.kid = true;
    if (findAll("pet", s).length) { o.pet = true; o.found.push("반려동물"); }
    let party = null;
    if (o.kid) party = "family";
    else if (o.senior) party = "senior";
    else if (ph.length) {
      const order = ["couple", "group", "friends", "solo"];
      party = ph.slice().sort((a, b) => b.len - a.len || order.indexOf(a.v) - order.indexOf(b.v))[0].v;
    }
    if (party) hit("party", party, PARTY_LABEL[party]);
    if (o.kid && o.senior) o.found.push("어르신도 함께");

    // 인원
    let ppl = null;
    if ((m = raw.match(/(\d{1,2})\s*(명|인)(?!\s*당)/))) ppl = Number(m[1]);
    else { const pp = best(findAll("people", s)); if (pp) ppl = Number(pp.v); }
    const kc = raw.match(/(아이|애|아들|딸|조카|아기|애기)\s*(하나|한\s*명|둘|두\s*명|셋|세\s*명|넷|네\s*명)/);
    if (kc) { const n = /하나|한/.test(kc[2]) ? 1 : /둘|두/.test(kc[2]) ? 2 : /셋|세/.test(kc[2]) ? 3 : 4; o.kids = n; o.found.push(`아이 ${n}명`);
      if (ppl && !/\d\s*(명|인)/.test(raw)) ppl = null; }
    if (ppl) { hit("people", ppl, `${ppl}명`); if (ppl >= 9 && (!o.party || o.party === "friends")) { o.party = "group"; } }
    if (o.party === "solo" && ppl && ppl > 1) o.party = ppl >= 9 ? "group" : "friends";

    // 이동
    const carYes = findAll("car", s).length, transit = findAll("transit", s).length;
    if (carYes) hit("car", true, "차로 와요");
    else if (transit) hit("car", false, "대중교통");
    const fr = best(findAll("from", s));
    if (fr) { o.from = fr.v; o.found.push({ station: "강릉역에서", terminal: "터미널에서", wolhwa: "시내에서" }[fr.v]); }

    // 몸 상태
    for (const h of findAll("body", s)) {
      const k = h.v === "kidsSmall" ? "stroller" : h.v;
      if (!o.body[k]) { o.body[k] = true; if (BODY_LABEL[k]) o.found.push(BODY_LABEL[k]); }
    }
    if (o.body.sick) o.sick = true;

    // 원하는 것
    for (const h of findAll("want", s)) {
      if (!o.wants[h.v]) { o.wants[h.v] = true; if (WANT_LABEL[h.v]) o.found.push(WANT_LABEL[h.v]); }
    }
    if (o.wants.private) o.private = true;
    if (o.wants.cheap) o.cheap = true;
    if (o.wants.wine) o.wine = true;
    if (o.wants.swim) o.swim = true;
    if (o.wants.bakery) o.bakery = true;
    if ((o.wants.anniv || o.wants.propose) && !o.party) hit("party", "couple", PARTY_LABEL.couple);
    if ((o.wants.anniv || o.wants.propose || o.wants.photo) && !o.slot && o.time == null) hit("slot", "sunset", "노을");
    if (o.wants.early && !o.slot) hit("slot", "am", "오전");
    if (o.wants.night && !o.slot) o.nightWalk = true;

    // 먹을 것
    let fh = best(findAll("food", s));
    // 한 글자 '회'는 띄어 쓴 경우가 많아 따로 봐요 ("끝나고 회 먹고", "회 한 접시")
    if (!fh && /(^|[^가-힣])회(?=$|[\s,.!?~]|를|도|랑|나|는|가|에|먹|한|좀|덮밥|센터|무침|같은|로)/.test(raw)) fh = { v: "회" };
    if (fh) hit("food", fh.v, fh.v);
    else if (findAll("meal", s).length) hit("meal", true, "식사");
    if (o.food === "피자" && o.wants.beer === undefined && /피맥/.test(sq)) o.wants.beer = true;

    // 순서
    const od = findAll("order", s).map(h => h.v);
    if (od.includes("noAfter")) hit("noAfter", true, "탄 뒤 바로 출발");
    if (od.includes("cafeOnly")) { hit("cafeOnly", true, "식사는 빼고"); o.meal = false; o.food = o.food || null; }
    if (!o.cafeOnly && /(점심|아침|밥|식사|브런치|대게|회|버거|돈까스|돈가스|닭강정|미역국|피자|꼬치)[^.]{0,8}(먹고|먹은\s*(뒤|후|다음)|하고|한\s*(뒤|후|다음))/.test(raw)
        && !/(타고|탄\s*(뒤|후|다음)|내려서|내리고|끝나고)[^.]{0,10}(점심|저녁|밥|식사|먹)/.test(raw)) hit("preMeal", true, "타기 전 식사");

    // 예약·업체
    const co = best(findAll("company", s));
    if (co) { o.company = co.v; o.found.push({ clubyacht: "클럽요트마스터", lunarossa: "루나로사", yachtgallery: "요트갤러리", marinaho: "강릉마리나호" }[co.v]); }
    if (findAll("booked", s).length) { o.bookedText = true; o.found.push("이미 예약"); }
    return o;
  }

  /* ---------- 카페·식당 점수 ---------- */
  const TAG_TEXT = { view: "바다가 잘 보여요", rooftop: "테라스에서 바다를 봐요", bakery: "빵 맛 평이 좋아요", dessert: "디저트가 인기예요",
    coffee: "커피 맛 평이 좋아요", pet: "반려견과 있을 수 있는 공간이 있어요", elevator: "엘리베이터가 있어 편해요", photo: "사진 찍기 좋아요",
    quiet: "비교적 아늑해요", work: "자리마다 콘센트가 있어요", group: "여럿이 앉기 좋아요", beer: "맥주를 곁들이기 좋아요", share: "나눠 먹기 좋아요",
    kids: "아이와 먹기 쉬워요", early: "아침 일찍 열어요", late: "늦게까지 열어요", chain: "익숙한 메뉴예요", takeout: "포장도 돼요",
    warm: "따뜻한 실내에서 쉬어요", near: "가까워요" };
  function profile(p) {
    const pr = (DICT().places || {})[p.name] || { tags: [] };
    const tags = new Set(pr.tags || []);
    if ((p.walk || 0) <= 3) tags.add("near");
    if (p.menu) (pr.menu2 = pr.menu2 || []).includes(p.menu) || pr.menu2.push(p.menu);
    if (/브레드|빵|베이커리/.test(p.name)) tags.add("bakery");
    return { pr, tags, menus: pr.menu2 || (p.menu ? [p.menu] : []) };
  }
  function weatherClass(w) { return !w ? "normal" : w.rain ? "rain" : w.cold ? "cold" : "normal"; }
  function score(p, kind, o, w) {
    const F = DICT().fit || {}, { tags, menus } = profile(p);
    let sc = 0, why = [];
    const add = (table, mult = 1) => { for (const t in table || {}) if (tags.has(t)) { sc += table[t] * mult; if (table[t] > 0) why.push([t, table[t] * mult]); } };
    const party = o.pet ? null : o.party;
    if (party) add((F.party || {})[party]);
    if (o.pet) add((F.party || {}).pet);
    if (o.senior && party !== "senior") add((F.party || {}).senior, 0.6);
    if (o.kid && party !== "family") add((F.party || {}).family, 0.6);
    for (const k in o.wants || {}) if (o.wants[k]) add((F.want || {})[k]);
    for (const k in o.body || {}) if (o.body[k]) add((F.want || {})[k]);
    if (o.bakery) add((F.want || {}).bakery);
    add(((F.weather || {})[weatherClass(w)]));
    if (o.car && tags.has("beer") && o.wants && o.wants.beer) sc += F.carNoBeer || -4;
    if (kind === "food") {
      if (o.food && menus.includes(o.food)) { sc += F.foodMatch || 100; why.unshift(["menu", 99]); }
      if ((o.kid || o.party === "family") && menus.some(x => /돈까스|버거|미역국|닭강정|피자/.test(x))) sc += 3;
    }
    why.sort((a, b) => b[1] - a[1]);
    return { s: sc, why: why.map(x => x[0]) };
  }
  const reasonOf = (p, kind, o, w, base) => {
    const r = score(p, kind, o, w).why.filter(t => t !== "menu" && TAG_TEXT[t]);
    return [base, r[0] ? TAG_TEXT[r[0]] : ""].filter(Boolean).join(" · ");
  };

  /* ---------- 고르는 순서 (조금의 무작위) ----------
     카페: 상황에 맞는 곳들 중에서 무작위 (잘 맞을수록, 최근에 안 본 곳일수록 잘 뽑혀요). 거리는 조금만 봐요.
     식당: 후기에 맞는 곳 우선, 점수가 비슷한 곳끼리만 무작위.
     seed 가 같으면 결과도 같아요 (공유 링크의 &s=). seed 가 없으면 점수 순서 그대로. */
  const PICK = { cafe: { walk: 0.15, window: 7, temp: 3, recent: 0.35 }, food: { walk: 0.6, window: 2.5, temp: 1.5, recent: 0.7 } };
  const REVIEW_BONUS = { food: { "많음": 2, "조금": 1 }, cafe: { "많음": 1, "조금": 0.5 } };
  function rng(seed, salt) {
    let h = (Number(seed) >>> 0) ^ 2166136261;
    for (const ch of String(salt)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function fitScore(p, kind, o, w, at) {
    const pr = ((DICT().places || {})[p.name]) || {};
    return score(p, kind, o, w).s + ((REVIEW_BONUS[kind] || {})[pr.review] || 0) - (PICK[kind] || PICK.food).walk * Math.abs((p.walk || 0) - (at || 0));
  }
  // xs: [{p, sc, ...}] → 고르는 순서
  function order(xs, kind, o, salt) {
    const sorted = xs.slice().sort((a, b) => b.sc - a.sc || (a.mv || 0) - (b.mv || 0));
    if (o.seed == null || sorted.length < 2) return sorted;
    const k = PICK[kind] || PICK.food, top = sorted[0].sc, recent = new Set(o.recent || []);
    const inWin = sorted.filter(x => x.sc >= top - k.window), rest = sorted.filter(x => x.sc < top - k.window);
    const r = rng(o.seed, salt);
    const keyed = inWin.map(x => {
      const wgt = Math.exp((x.sc - top) / k.temp) * (recent.has(x.p.name) ? k.recent : 1);
      return { x, key: Math.pow(r(), 1 / wgt) };
    }).sort((a, b) => b.key - a.key).map(y => y.x);
    return keyed.concat(rest);
  }

  // 끝나는 시각 전에 둘 여유: 기차·버스 시각이면 이동 시간까지 (대중교통 50분, 차 30분), 아니면 20분
  const endBuffer = o => o.endTravel ? (o.car ? 30 : 50) : 20;

  /* ---------- 내린 뒤 일정 ---------- */
  // ctx: { o, wd, t(내려서 정리한 뒤 시각), w:{cold,rain,storm}, P:{cafe,food}, used:Set, at, swaps, endBy }
  function planAfter(ctx) {
    const { wd, P, w = {} } = ctx;
    const o = ctx.o.preMeal ? Object.assign({}, ctx.o, { food: null }) : ctx.o;   // 타기 전에 이미 먹었으면 메뉴 조건은 빼요
    const used = ctx.used || new Set(), swaps = ctx.swaps || {};
    let t = ctx.t, at = ctx.at || 0;
    const steps = [], notes = [], cands = [];
    const limit = Math.min(DAY_END, o.endBy != null ? o.endBy - endBuffer(o) : DAY_END);
    const choose = (kind, list, base, idx) => {
      let ok = (list || []).filter(p => !used.has(p.name)).map(p => {
        const mv = Math.max(2, Math.abs((p.walk || 0) - at)), st = r10(t + mv);
        return { p, mv, st, sc: fitScore(p, kind, o, w, at) };
      }).filter(x => openAt(x.p, wd, x.st, STAY[kind]) && x.st + STAY[kind] <= limit);
      if (!ok.length) return false;
      cands.push({ kind, names: ok.slice().sort((a, b) => b.sc - a.sc || a.mv - b.mv).slice(0, kind === "cafe" ? 15 : 8).map(x => x.p.name) });
      ok = order(ok, kind, o, `${kind}${idx}${t}`);
      const x = ok[(swaps[idx] || 0) % ok.length];
      used.add(x.p.name);
      steps.push({ kind: "move", text: `걸어서 약 ${x.mv}분` });
      t = x.st;
      let b2 = base;
      if (kind === "food" && o.food && !profile(x.p).menus.includes(o.food)) {
        b2 = base.replace(` · ${o.food}`, "") + ` · ${o.food} 가게가 이 시각엔 쉬어서 대신`;
        notes.push(`${o.food} 가게가 그 시각에 문을 닫아 다른 식당을 넣었어요.`);
      }
      steps.push({ kind, time: t, end: t + STAY[kind], place: x.p, title: x.p.name, sub: reasonOf(x.p, kind, o, w, b2), alt: ok.length, idx });
      t += STAY[kind]; at = x.p.walk || 0;
      return true;
    };
    const cold = w.cold || w.rain || w.storm;
    const wantMeal = !o.cafeOnly && !o.noAfter && (o.meal || o.food);
    let ateMeal = false, waited = false;
    if (o.noAfter) return { steps, t, at, ateMeal, notes, cands, waited };
    const foodBase = () => `${mealLabel(r10(t))}${o.food ? ` · ${o.food}` : ""}`;
    if (!o.cafeOnly && isMeal(r10(t)) && !(o.preMeal && r10(t) < 15 * 60)) {
      ateMeal = choose("food", P.food, foodBase(), 0);
      choose("cafe", P.cafe, "식사 뒤 바다 보며 커피 한 잔", 1);
    } else {
      choose("cafe", P.cafe, cold ? "바닷바람에 식은 몸, 따뜻한 음료로" : "바다 보며 커피 한 잔", 0);
      if (!o.cafeOnly && (isMeal(r10(t)) || (!o.preMeal && wantMeal && t < 20 * 60))) {
        if (!isMeal(r10(t)) && t < 17 * 60) { t = 17 * 60; waited = true; cands.push({ kind: "wait", names: [] }); }
        ateMeal = choose("food", P.food, foodBase(), 1);
      }
    }
    if (wantMeal && !ateMeal && !o.preMeal) notes.push(o.endBy != null ? "끝나는 시각 안에 식사를 넣을 시간이 모자라요." : "말씀하신 식사는 이 시간대에 문 연 가게가 없어 넣지 못했어요. 시간대를 바꿔 보세요.");
    if (o.endBy != null) notes.push(o.endTravel ? `${fmt(o.endBy)} ${o.car ? "출발" : "기차·버스"}에 맞춰 ${o.car ? "" : "강릉역·터미널까지 버스 시간(약 35분)과 "}여유를 두고 ${fmt(o.endBy - endBuffer(o))}까지 끝냈어요.` : `${fmt(o.endBy)}까지 떠날 수 있게 20분 여유를 두고 끝냈어요.`);
    return { steps, t, at, ateMeal, notes, cands, waited };
  }

  /* ---------- 타기 전 식사 ---------- */
  function planBefore(ctx) {
    const { o, wd, P, dep, w = {} } = ctx, swaps = ctx.swaps || {};
    const ok = (P.food || []).map(p => {
      const mv = Math.max(2, p.walk || 0), st = Math.floor((dep - 60 - STAY.food - mv) / 10) * 10;
      return { p, mv, st, sc: fitScore(p, "food", o, w, 0) };
    }).filter(x => x.st >= 7 * 60 && openAt(x.p, wd, x.st, STAY.food));
    if (!ok.length) return null;
    const cands = ok.slice().sort((a, b) => b.sc - a.sc || a.mv - b.mv).slice(0, 8).map(y => y.p.name);
    const ord = order(ok, "food", o, `pre${dep}`);
    const x = ord[(swaps.pre || 0) % ord.length];
    return { x, cands, alt: ok.length,
      step: { kind: "food", time: x.st, end: x.st + STAY.food, place: x.p, title: x.p.name,
        sub: reasonOf(x.p, "food", o, w, `${x.st < 15 * 60 ? "점심" : "식사"} 먼저${o.food ? ` · ${o.food}` : ""}`), alt: ok.length, idx: "pre" },
      move: { kind: "move", text: `마리나까지 걸어서 약 ${x.mv}분` } };
  }

  /* ---------- 미리 계산 표 ---------- */
  const DIM = {
    party: ["couple", "family", "senior", "friends", "group", "solo", "pet"],
    food: ["", "meal", "대게", "회", "버거", "돈까스", "닭강정", "미역국", "피자", "꼬치", "빵"],
    weather: ["normal", "cold", "rain"],
    after: { from: 600, step: 30, n: 24 },     // 10:00 ~ 21:30
    before: { from: 600, step: 30, n: 19 }     // 10:00 ~ 19:00 출항
  };
  // 표로 바로 낼 수 있는 단순한 조건인지 (특별 요청이 있으면 그 자리에서 계산)
  function simple(o) {
    const extra = Object.keys(o.wants || {}).filter(k => o.wants[k] && !["wine", "swim", "private", "cheap", "longRide", "shortRide", "bakery"].includes(k));
    return !extra.length && !Object.keys(o.body || {}).some(k => o.body[k] && k !== "sick") && o.endBy == null && !o.cafeOnly && !o.noAfter
      && !(o.kid && o.party !== "family") && !(o.senior && o.party !== "senior");
  }
  const foodDim = o => o.food ? o.food : o.bakery ? "빵" : o.meal ? "meal" : "";
  const partyDim = o => o.pet ? "pet" : (o.party || "couple");
  function keyAfter(o, wd, t, w) {
    const b = Math.floor((t - DIM.after.from) / DIM.after.step);
    if (b < 0 || b >= DIM.after.n) return -1;
    const pi = DIM.party.indexOf(partyDim(o)), fi = DIM.food.indexOf(foodDim(o)), wi = DIM.weather.indexOf(weatherClass(w));
    if (pi < 0 || fi < 0 || wi < 0) return -1;
    return ((((wd * DIM.after.n + b) * DIM.party.length + pi) * DIM.food.length + fi) * DIM.weather.length + wi);
  }
  function keyBefore(o, wd, dep) {
    const b = Math.floor((dep - DIM.before.from) / DIM.before.step);
    if (b < 0 || b >= DIM.before.n) return -1;
    const FB = DIM.food.slice(1), pi = DIM.party.indexOf(partyDim(o)), fi = FB.indexOf(foodDim(o) || "meal");
    if (pi < 0 || fi < 0) return -1;
    return (((wd * DIM.before.n + b) * DIM.party.length + pi) * FB.length + fi);
  }
  // 표에서 꺼내기: [{kind, names:[...]}] 또는 null
  function lookup(which, key) {
    const C = root.COURSE_CASES;
    if (!C || key < 0) return null;
    const wdt = C.w || 2, idx = C[which], code = idx && idx.substr(key * wdt, wdt);
    if (!code || code.length < wdt) return null;
    const v = C.values[parseInt(code, 36)];
    if (v == null) return null;
    if (v === "") return [];
    return v.split(";").map(part => {
      const [k, ...ns] = part.split(",");
      return { kind: k === "f" ? "food" : k === "c" ? "cafe" : "wait", names: ns.map(n => C.places[parseInt(n, 36)]) };
    });
  }
  // 표의 추천 순서를 그대로 쓰되, 실제 시각에 열려 있는지 다시 확인
  function planAfterFast(ctx) {
    const { wd, w = {} } = ctx;
    const o = ctx.o.preMeal ? Object.assign({}, ctx.o, { food: null }) : ctx.o;
    if (!simple(o)) return null;
    const key = keyAfter(o, wd, ctx.t, w);
    const t0 = DIM.after.from + Math.floor((ctx.t - DIM.after.from) / DIM.after.step) * DIM.after.step;
    if (isMeal(r10(t0)) !== isMeal(r10(ctx.t))) return null;   // 식사 시간 경계면 그 자리에서 계산
    const rows = lookup("after", key);
    if (!rows) return null;
    const used = new Set(ctx.used || []), swaps = ctx.swaps || {};   // 실패하면 원래 목록을 건드리지 않게 복사
    let t = ctx.t, at = ctx.at || 0, ateMeal = false, waited = false, i = 0;
    const steps = [], all = [...(ctx.P.cafe || []), ...(ctx.P.food || [])];
    const cold = w.cold || w.rain || w.storm;
    for (const r of rows) {
      if (r.kind === "wait") { if (t < 17 * 60) { t = 17 * 60; waited = true; } continue; }
      const list = r.names.map(n => all.find(p => p.name === n)).filter(Boolean).filter(p => !used.has(p.name));
      let ok = list.map(p => ({ p, mv: Math.max(2, Math.abs((p.walk || 0) - at)) })).map(x => Object.assign(x, { st: r10(t + x.mv), sc: fitScore(x.p, r.kind, o, w, at) }))
        .filter(x => openAt(x.p, wd, x.st, STAY[r.kind]) && x.st + STAY[r.kind] <= DAY_END);
      if (!ok.length) return null;            // 표와 실제 시각이 어긋나면 그 자리에서 계산
      ok = order(ok, r.kind, o, `${r.kind}${i}${t}`);
      const x = ok[(swaps[i] || 0) % ok.length];
      used.add(x.p.name);
      steps.push({ kind: "move", text: `걸어서 약 ${x.mv}분` });
      t = x.st;
      const miss = r.kind === "food" && o.food && !profile(x.p).menus.includes(o.food);
      const base = r.kind === "food" ? `${mealLabel(t)}${o.food ? (miss ? ` · ${o.food} 가게가 이 시각엔 쉬어서 대신` : ` · ${o.food}`) : ""}` : i === 0 ? (cold ? "바닷바람에 식은 몸, 따뜻한 음료로" : "바다 보며 커피 한 잔") : "식사 뒤 바다 보며 커피 한 잔";
      steps.push({ kind: r.kind, time: t, end: t + STAY[r.kind], place: x.p, title: x.p.name, sub: reasonOf(x.p, r.kind, o, w, base), alt: ok.length, idx: i });
      t += STAY[r.kind]; at = x.p.walk || 0;
      if (r.kind === "food") ateMeal = true;
      i++;
    }
    if (ctx.used) for (const n of used) ctx.used.add(n);
    return { steps, t, at, ateMeal, notes: [], cands: rows, waited, fromTable: true };
  }

  function planBeforeFast(ctx) {
    const { o, wd, dep, w = {} } = ctx, swaps = ctx.swaps || {};
    if (!simple(o)) return null;
    const rows = lookup("before", keyBefore(o, wd, dep));
    if (!rows || !rows.length) return null;
    let ok = rows[0].names.map(n => (ctx.P.food || []).find(p => p.name === n)).filter(Boolean).map(p => {
      const mv = Math.max(2, p.walk || 0), st = Math.floor((dep - 60 - STAY.food - mv) / 10) * 10;
      return { p, mv, st, sc: fitScore(p, "food", o, w, 0) };
    }).filter(x => x.st >= 7 * 60 && openAt(x.p, wd, x.st, STAY.food));
    if (!ok.length) return null;
    ok = order(ok, "food", o, `pre${dep}`);
    const x = ok[(swaps.pre || 0) % ok.length];
    return { x, cands: rows[0].names, alt: ok.length, fromTable: true,
      step: { kind: "food", time: x.st, end: x.st + STAY.food, place: x.p, title: x.p.name,
        sub: reasonOf(x.p, "food", o, w, `${x.st < 15 * 60 ? "점심" : "식사"} 먼저${o.food ? ` · ${o.food}` : ""}`), alt: ok.length, idx: "pre" },
      move: { kind: "move", text: `마리나까지 걸어서 약 ${x.mv}분` } };
  }

  root.YF = { endBuffer, planBeforeFast, order, fitScore, rng, PICK, parse, score, profile, planAfter, planAfterFast, planBefore, openAt, simple, keyAfter, keyBefore, lookup, weatherClass,
    DIM, STAY, hm, fmt, r10, isMeal, TAG_TEXT, PARTY_LABEL };
})(typeof window !== "undefined" ? window : globalThis);
