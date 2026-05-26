import subprocess

# Tiny JS that exercises the EXACT Gemini call the recap job makes, from inside
# the hamster-app container (validates egress + key validity + reachability).
js = r"""
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
const ac = new AbortController();
const t = setTimeout(() => ac.abort(), 15000);
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }] }),
  signal: ac.signal,
}).then(async (r) => {
  const body = await r.text();
  console.log('HTTP_STATUS', r.status);
  console.log('BODY', body.slice(0, 400));
}).catch((e) => {
  console.log('FETCH_ERROR', e.name, e.message);
}).finally(() => clearTimeout(t));
"""

r = subprocess.run(
    "docker compose exec -T hamster-app node",
    shell=True, input=js, capture_output=True, text=True,
    cwd='/opt/hamster-cam', timeout=40,
)
print("=== gemini egress test (from inside hamster-app container) ===")
print(r.stdout or "(no stdout)")
if r.stderr.strip():
    print("--- stderr ---")
    print(r.stderr)
