// =====================================================================
// 요트핏 날씨 자동 업데이트 (GitHub Actions에서 1시간마다 실행)
// ---------------------------------------------------------------------
// - 인증키는 GitHub 저장소 Settings → Secrets → KMA_KEY 에만 넣습니다.
//   (공공데이터포털의 "일반 인증키 (Decoding)" 값을 넣어 주세요)
// - 기상청 API 4개를 불러 weather.json 한 파일로 저장합니다.
// - 사이트(index.html)는 이 파일만 읽습니다. 키는 사이트에 노출되지 않습니다.
// - 일부 API가 실패해도 나머지는 저장하고, 실패한 부분은 이전 값을 유지합니다.
// =====================================================================
import { readFile, writeFile } from "node:fs/promises";

/* ---------- 설정 (필요하면 여기만 고치세요) ---------- */
const CONFIG = {
  lat: 37.773225, lon: 128.94735,    // 안목해변 관측 위치 (해수욕장 날씨 목록 기준, 마리나 바로 옆)
  grid: { nx: 94, ny: 132 },          // 기상청 격자 (해수욕장 목록의 공식 값. 비우면 위경도로 계산)
  midLandReg: "11D20000",             // 중기육상예보 구역: 강원도영동
  midTaReg: "11D20501",               // 중기기온 지점: 강릉
  midSeaReg: "12C20000",              // 중기해상예보 구역: 동해중부
  alertAreas: ["강원중부앞바다"],       // 이 구역에 풍랑특보가 있으면 '운항이 어려운 날'
  beachNum: "174",                    // 해수욕장 번호 (안목해변)
  out: "weather.json"
};
const BASE = process.env.KMA_BASE || "https://apis.data.go.kr/1360000";
const RAW_KEY = (process.env.KMA_KEY || "").trim();

/* ---------- 시간 도우미 (GitHub 서버는 UTC라 한국 시간으로 바꿔 계산) ---------- */
const kstNow = () => new Date(Date.now() + 9 * 3600e3);              // 한국 시각을 UTC 필드에 담은 Date
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");      // 20261126
const isoDate = d => d.toISOString().slice(0, 10);                    // 2026-11-26
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);
const hhmm = d => d.toISOString().slice(11, 16);                      // 10:40

/* ---------- 기상청 격자 좌표 변환 (위경도 → nx, ny) ---------- */
function toGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30, SLAT2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136;
  const D = Math.PI / 180, re = RE / GRID;
  const s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5));
  let sf = Math.pow(Math.tan(Math.PI * 0.25 + s1 * 0.5), sn) * Math.cos(s1) / sn;
  let ro = re * sf / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  let ra = re * sf / Math.pow(Math.tan(Math.PI * 0.25 + lat * D * 0.5), sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

/* ---------- 해 지는 시각 계산 (API가 없거나 실패할 때 대신 사용) ---------- */
function calcSunset(dateKst, lat, lon) {
  const D = Math.PI / 180;
  const start = Date.UTC(dateKst.getUTCFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(dateKst.getUTCFullYear(), dateKst.getUTCMonth(), dateKst.getUTCDate()) - start) / 86400e3);
  const g = 2 * Math.PI / 365 * (day - 1 + 0.5);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * D) / (Math.cos(lat * D) * Math.cos(decl)) - Math.tan(lat * D) * Math.tan(decl)) / D;
  const utcMin = 720 - 4 * (lon - ha) - eqt;            // 일몰 (UTC 분)
  const k = Math.round(utcMin + 540) % 1440;            // 한국 시각 분
  return `${String(Math.floor(k / 60)).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}`;
}

/* ---------- API 호출 ---------- */
// 칸 하나에 키를 여러 줄로 넣어도 동작: 줄·띄어쓰기로 나눠 후보로 만들고, 맞는 키를 찾아 써요.
// Encoding 키(%2B 등이 들어간 키)를 넣어도 자동으로 풀어서 써요.
const KEY_CANDIDATES = [...new Set(RAW_KEY.split(/\s+/).filter(Boolean).map(k => {
  try { return k.includes("%") ? decodeURIComponent(k) : k; } catch { return k; }
}))];
let KEY = KEY_CANDIDATES[0] || "";
async function chooseKey(probe) {
  if (KEY_CANDIDATES.length <= 1) return;
  for (const k of KEY_CANDIDATES) {
    KEY = k;
    try { await probe(); console.log(`키 후보 ${KEY_CANDIDATES.length}개 중 ${KEY_CANDIDATES.indexOf(k) + 1}번째 키를 사용해요.`); return; }
    catch (e) { if (!/SERVICE_KEY|등록되지 않은/.test(e.message)) { console.log(`키 후보 ${KEY_CANDIDATES.indexOf(k) + 1}번째 사용 (응답: ${e.message.slice(0, 80)})`); return; } }
  }
  KEY = KEY_CANDIDATES[0];
  console.warn(`키 후보 ${KEY_CANDIDATES.length}개 모두 '등록되지 않은 서비스키'예요.`);
}
async function call(path, params) {
  const url = new URL(`${BASE}/${path}`);
  const q = { serviceKey: KEY, pageNo: "1", numOfRows: "1000", dataType: "JSON", ...params };
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${path}: JSON이 아님 (${text.slice(0, 120).replace(/\s+/g, " ")})`); }
  const code = json?.response?.header?.resultCode;
  if (code !== "00") {
    const msg = json?.response?.header ? `${code} ${json.response.header.resultMsg}` : `HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, " ")}`;
    throw new Error(`${path}: ${msg}`);
  }
  const item = json?.response?.body?.items?.item;
  return Array.isArray(item) ? item : item ? [item] : [];
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const SKY = { "1": "맑음", "3": "구름많음", "4": "흐림" };
const PTY = { "1": "비", "2": "비/눈", "3": "눈", "4": "소나기", "5": "빗방울", "6": "빗방울/눈날림", "7": "눈날림" };

/* ---------- 1. 초단기실황: 지금 기온·바람 ---------- */
async function getNow(grid, now) {
  const t = new Date(now.getTime() - (now.getUTCMinutes() < 45 ? 3600e3 : 0));  // 매시 40분 이후 발표
  const items = await call("VilageFcstInfoService_2.0/getUltraSrtNcst",
    { base_date: ymd(t), base_time: `${String(t.getUTCHours()).padStart(2, "0")}00`, ...grid });
  const v = c => num(items.find(i => i.category === c)?.obsrValue);
  return { temp: v("T1H"), wind: v("WSD") };
}

/* ---------- 2. 단기예보: 오늘~3일 ---------- */
async function getShort(grid, now) {
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  let t = new Date(now.getTime() - 15 * 60e3);
  let h = slots.find(s => s <= t.getUTCHours());
  if (h === undefined) { t = addDays(t, -1); h = 23; }
  const items = await call("VilageFcstInfoService_2.0/getVilageFcst",
    { base_date: ymd(t), base_time: `${String(h).padStart(2, "0")}00`, ...grid });
  const days = {};
  for (const i of items) {
    const d = `${i.fcstDate.slice(0, 4)}-${i.fcstDate.slice(4, 6)}-${i.fcstDate.slice(6, 8)}`;
    const hr = Number(i.fcstTime.slice(0, 2));
    const x = days[d] ||= { date: d, wind: null, wave: null, tmax: null, tmin: null, sky: null, pty: null };
    const v = num(i.fcstValue);
    if (i.category === "TMX") x.tmax = v;
    if (i.category === "TMN") x.tmin = v;
    if (i.category === "WSD" && hr >= 9 && hr <= 18 && v != null) x.wind = Math.max(x.wind ?? 0, v);
    if (i.category === "WAV" && hr >= 9 && hr <= 18 && v != null) x.wave = Math.max(x.wave ?? 0, v);
    if (i.category === "SKY" && hr === 12) x.sky = SKY[i.fcstValue] || x.sky;
    if (i.category === "PTY" && hr >= 9 && hr <= 18 && i.fcstValue !== "0") x.pty = PTY[i.fcstValue] || x.pty;
    if (i.category === "SKY" && x.sky == null && hr >= 9) x.sky = SKY[i.fcstValue] || null;
  }
  // 지금 시각과 가장 가까운 파고 (바다 격자일 때만 값이 있어요)
  const nowKey = ymd(now) + String(now.getUTCHours()).padStart(2, "0");
  const wav = items.filter(i => i.category === "WAV").sort((a, b) =>
    Math.abs(Number(a.fcstDate + a.fcstTime.slice(0, 2)) - Number(nowKey)) - Math.abs(Number(b.fcstDate + b.fcstTime.slice(0, 2)) - Number(nowKey)))[0];
  return {
    days: Object.values(days).map(x => ({ date: x.date, sky: x.pty || x.sky || "", tmax: x.tmax, tmin: x.tmin, wind: x.wind, wave: x.wave })),
    waveNow: wav ? num(wav.fcstValue) : null
  };
}

/* ---------- 3. 중기예보: 3~10일 ---------- */
async function getMid(now) {
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  let base = now, tm = "0600";
  if (hm < 6 * 60 + 30) { base = addDays(now, -1); tm = "1800"; }
  else if (hm >= 18 * 60 + 30) tm = "1800";
  const tmFc = ymd(base) + tm;
  const [land, ta, sea] = await Promise.all([
    call("MidFcstInfoService/getMidLandFcst", { regId: CONFIG.midLandReg, tmFc }).catch(e => (console.warn("중기육상:", e.message), [])),
    call("MidFcstInfoService/getMidTa", { regId: CONFIG.midTaReg, tmFc }).catch(e => (console.warn("중기기온:", e.message), [])),
    call("MidFcstInfoService/getMidSeaFcst", { regId: CONFIG.midSeaReg, tmFc }).catch(e => (console.warn("중기해상:", e.message), []))
  ]);
  const L = land[0] || {}, T = ta[0] || {}, S = sea[0] || {};
  const out = [];
  for (let n = 3; n <= 10; n++) {
    const sky = L[`wf${n}Pm`] || L[`wf${n}`] || L[`wf${n}Am`] || "";
    const waves = [S[`wh${n}BAm`], S[`wh${n}BPm`], S[`wh${n}B`], S[`wh${n}AAm`], S[`wh${n}APm`], S[`wh${n}A`]].map(num).filter(v => v != null);
    const row = { date: isoDate(addDays(base, n)), sky, tmax: num(T[`taMax${n}`]), tmin: num(T[`taMin${n}`]), wind: null, wave: waves.length ? Math.max(...waves) : null };
    if (row.sky || row.tmax != null || row.wave != null) out.push(row);
  }
  return out;
}

/* ---------- 4. 기상특보: 풍랑주의보·경보 ---------- */
async function getAlert() {
  const items = await call("WthrWrnInfoService/getPwnStatus", {});
  const text = items.map(i => i.t6 || "").join("\n");
  const lines = text.split(/\n|o\s/).filter(l => /풍랑/.test(l));
  const hit = lines.find(l => CONFIG.alertAreas.some(a => l.includes(a)));
  if (!hit) return "없음";
  return /경보/.test(hit.split(":")[0]) ? "풍랑경보" : "풍랑주의보";
}

/* ---------- 5. 해수욕장 날씨: 파고·수온·일몰 (번호가 있을 때만) ---------- */
async function getBeach(now) {
  if (!CONFIG.beachNum) return {};
  const st = ymd(now) + String(now.getUTCHours()).padStart(2, "0") + "00";
  const pick = (items, keys) => { for (const it of items) for (const k of keys) if (it[k] != null && it[k] !== "") return it[k]; return null; };
  const [wh, tw, sun] = await Promise.all([
    call("BeachInfoservice/getWhBuoyBeach", { beach_num: CONFIG.beachNum, searchTime: st }).catch(e => (console.warn("해수욕장 파고:", e.message), [])),
    call("BeachInfoservice/getTwBuoyBeach", { beach_num: CONFIG.beachNum, searchTime: st }).catch(e => (console.warn("해수욕장 수온:", e.message), [])),
    call("BeachInfoservice/getSunInfoBeach", { beach_num: CONFIG.beachNum, base_date: ymd(now) }).catch(e => (console.warn("해수욕장 일몰:", e.message), []))
  ]);
  const sunset = String(pick(sun, ["sunset", "sunSet"]) || "").replace(/[^0-9]/g, "");
  return {
    wave: num(pick(wh, ["wh", "waveHeight"])),
    water: num(pick(tw, ["tw", "waterTemp"])),
    sunset: sunset.length >= 4 ? `${sunset.slice(0, 2)}:${sunset.slice(2, 4)}` : null
  };
}

/* ---------- 실행 ---------- */
async function main() {
  if (!KEY) { console.log("KMA_KEY가 없어 날씨 업데이트를 건너뜁니다."); return; }
  const now = kstNow();
  const grid = CONFIG.grid && CONFIG.grid.nx ? CONFIG.grid : toGrid(CONFIG.lat, CONFIG.lon);
  await chooseKey(() => getNow(grid, now));
  let prev = {};
  try { prev = JSON.parse(await readFile(CONFIG.out, "utf8")); } catch {}
  const prevCur = prev.current || {};
  const step = async (name, fn, fallback) => { try { return await fn(); } catch (e) { console.warn(`${name} 실패:`, e.message); return fallback; } };

  const [nowObs, short, mid, alert, beach] = await Promise.all([
    step("초단기실황", () => getNow(grid, now), {}),
    step("단기예보", () => getShort(grid, now), { days: [], waveNow: null }),
    step("중기예보", () => getMid(now), []),
    step("기상특보", () => getAlert(), prevCur.alert ?? ""),
    step("해수욕장", () => getBeach(now), {})
  ]);

  // 모두 실패했으면 (대부분 키 문제) 파일을 그대로 두고 실패로 끝내기
  if (nowObs.temp == null && !short.days.length && !mid.length) {
    throw new Error("기상청 API를 하나도 받지 못했어요. KMA_KEY(Decoding 키)와 활용신청 승인 상태를 확인해 주세요.");
  }

  // 날짜별로 합치기 (단기예보가 있으면 단기예보 우선)
  const byDate = {};
  for (const d of mid) byDate[d.date] = d;
  for (const d of short.days) byDate[d.date] = { ...(byDate[d.date] || {}), ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && v !== "")) };
  const today = isoDate(now);
  const days = Object.values(byDate).filter(d => d.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);
  if (days[0] && days[0].date === today && alert && alert !== "없음") days[0].alert = alert;

  const pickNum = (...v) => { for (const x of v) if (x != null) return x; return null; };
  const data = {
    updated: hhmm(now),
    updatedAt: now.toISOString().replace("Z", "+09:00"),
    source: "기상청",
    grid,
    current: {
      temp: pickNum(nowObs.temp, prevCur.temp),
      wind: pickNum(nowObs.wind, prevCur.wind),
      wave: pickNum(beach.wave, short.waveNow, days[0]?.wave, prevCur.wave),
      water: pickNum(beach.water, prevCur.water),
      alert: alert || ""
    },
    sunset: beach.sunset || calcSunset(now, CONFIG.lat, CONFIG.lon),
    days: days.length ? days : (prev.days || [])
  };
  await writeFile(CONFIG.out, JSON.stringify(data, null, 2) + "\n");
  console.log(`저장 완료: ${CONFIG.out} (${data.updated}, 격자 ${grid.nx},${grid.ny}, 예보 ${data.days.length}일)`);
}

main().catch(e => { console.error(e); process.exit(1); });
