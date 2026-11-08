// Serverless function. Keeps the API key secret on the server.
// Needs ONE env var in Netlify: GEMINI_API_KEY (or ANTHROPIC_API_KEY).
// Open this function's URL in a browser (GET) to see a self-test.
const SYSTEM = `You are "Next Step Navigator", a warm, brief assistant inside YourDOST, an employee wellbeing platform in India.
You are NOT a therapist. You never diagnose and never give treatment advice. Your only job: understand how the person feels and point them to ONE best next step.
Services (use these exact keys): counseling (1:1 online counseling), selfhelp (self-help articles/audio), assess (5-min stress/burnout assessment), group (group workshops/peer circles), sleep (sleep & relaxation exercises).
Rules:
- Ask at most 2 short, kind follow-up questions (one per turn). After that, recommend.
- If the person mentions self-harm, suicide, or not wanting to live, set "crisis": true.
- Plain, friendly language. Replies under 50 words. No medical claims.
- Reply ONLY with JSON: {"reply":string,"ready":boolean,"crisis":boolean,"primary":key|null,"alternatives":[key,key]|null,"why":string|null,"confidence":"High"|"Medium"|"Low"|null}
- "why" is 1-2 simple sentences explaining the recommendation using the person's own words. Use "Low" confidence if unsure.`;

const KEYS = ["counseling","selfhelp","assess","group","sleep"];
const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-2.5-flash-lite","gemini-2.5-flash","gemini-flash-lite-latest","gemini-flash-latest","gemini-2.0-flash"];
const json = (code, obj) => ({ statusCode: code, headers: {"Content-Type":"application/json"}, body: JSON.stringify(obj, null, 2) });
const clean = (s) => String(s).replace(process.env.GEMINI_API_KEY || "\u0000", "***").replace(process.env.ANTHROPIC_API_KEY || "\u0000", "***").slice(0, 300);

async function callOne(model, msgs, key, signal, sys) {
  const cfg = {responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 500};
  if (model.includes("2.5")) cfg.thinkingConfig = {thinkingBudget: 0};
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST", headers: {"content-type":"application/json"}, signal,
    body: JSON.stringify({
      systemInstruction: {parts:[{text: sys}]},
      contents: msgs.map(m => ({role: m.role === "assistant" ? "model" : "user", parts:[{text:m.content}]})),
      generationConfig: cfg
    })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${model} ${r.status}`);
  let t = null;
  try { t = JSON.parse(body).candidates[0].content.parts[0].text; } catch (e) {}
  if (!t) throw new Error(`${model} empty`);
  return t;
}

// Ask every model at the same time; the first good answer wins. Much more reliable than one at a time.
async function callGemini(msgs, sys) {
  const key = process.env.GEMINI_API_KEY;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 7500);
  try {
    const text = await Promise.any(MODELS.map(m => callOne(m, msgs, key, ac.signal, sys)));
    ac.abort(); // cancel the slower ones
    return text;
  } catch (e) {
    throw new Error(clean((e.errors || [e]).map(x => x.message).join(" | ")));
  } finally { clearTimeout(timer); }
}

async function callAnthropic(msgs, sys) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"content-type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
    body: JSON.stringify({model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 500, system: sys, messages: msgs})
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${clean(await r.text())}`);
  return (await r.json()).content[0].text;
}

function withDeadline(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("AI took too long, please try again")), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function ask(msgs) {
  const users = msgs.filter(m => m.role === "user").length;
  const sys = SYSTEM + (users >= 3 ? "\nYou have asked enough questions. Set ready to true and recommend NOW." : "");
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(msgs, sys);
  if (process.env.GEMINI_API_KEY) return callGemini(msgs, sys);
  throw new Error("no API key found: add GEMINI_API_KEY in Netlify environment variables (scope: Functions) and redeploy");
}

exports.handler = async (event) => {
  // Self-test: open the function URL in a browser
  if (event.httpMethod === "GET") {
    const out = {function: "deployed", geminiKeyPresent: !!process.env.GEMINI_API_KEY, anthropicKeyPresent: !!process.env.ANTHROPIC_API_KEY, modelsTried: MODELS};
    try { const t = await withDeadline(ask([{role:"user", content:"I feel stressed at work."}]), 9000); out.aiCall = "SUCCESS"; out.sample = clean(t); }
    catch (e) { out.aiCall = "FAILED"; out.reason = clean(e.message); }
    return json(200, out);
  }
  if (event.httpMethod !== "POST") return json(405, {error:"POST only"});
  let msgs;
  try { msgs = JSON.parse(event.body).messages; } catch (e) { return json(400, {error:"bad request"}); }
  msgs = (msgs || []).slice(-12).map(m => ({role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 800)}));
  if (!msgs.length) return json(400, {error:"no messages"});
  try {
    const text = await withDeadline(ask(msgs), 9000);
    const d = JSON.parse(text.replace(/```json|```/g, "").trim());
    const ok = k => KEYS.includes(k);
    const out = {reply: String(d.reply || "").slice(0, 400), crisis: !!d.crisis, ready: !!d.ready && ok(d.primary)};
    if (out.ready) {
      out.primary = d.primary;
      out.alternatives = (d.alternatives || []).filter(ok).filter(k => k !== d.primary).slice(0, 2);
      out.why = String(d.why || "").slice(0, 300);
      out.confidence = ["High","Medium","Low"].includes(d.confidence) ? d.confidence : "Medium";
    }
    return json(200, out); // nothing is logged or stored
  } catch (e) {
    return json(502, {error: clean(e.message)});
  }
};
