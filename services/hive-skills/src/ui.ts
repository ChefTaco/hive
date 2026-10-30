const styles = `
:root {
  --ink: #18222b;
  --paper: #edf1ec;
  --hive: #d4af37;
  --slate: #36505c;
  --line: #afc0bb;
  --alert: #9e3c26;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
header {
  background: var(--ink);
  color: #fff;
  padding: 1.6rem max(5vw, 1rem);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h1 {
  font: 700 clamp(2rem, 6vw, 4.7rem)/.85 Georgia, serif;
  letter-spacing: -.06em;
  margin: 0;
}
.stamp {
  color: var(--hive);
  font: 600 .7rem ui-monospace, monospace;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.grid {
  display: grid;
  grid-template-columns: 1.25fr .75fr;
  gap: 2rem;
  padding: 3rem max(5vw, 1rem);
  max-width: 1250px;
  margin: auto;
}
.intro {
  border-left: 6px solid var(--hive);
  padding-left: 1.2rem;
  font-size: 1.25rem;
  max-width: 38rem;
}
.card {
  background: #fff;
  border: 1px solid var(--line);
  padding: 1.25rem;
  box-shadow: 7px 7px 0 #cfdbd4;
  margin-top: 1rem;
}
.skill {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: .8rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--line);
}
.skill:last-child { border: 0; }
.hex {
  width: 2.25rem;
  height: 2.25rem;
  background: var(--hive);
  clip-path: polygon(25% 6%, 75% 6%, 100% 50%, 75% 94%, 25% 94%, 0 50%);
}
h2 { margin: .1rem 0; font: 700 1.4rem Georgia, serif; }
p { line-height: 1.5; margin: .4rem 0; }
form { display: grid; gap: .7rem; }
label {
  font: .72rem ui-monospace, monospace;
  text-transform: uppercase;
  letter-spacing: .08em;
}
input, textarea, select {
  width: 100%;
  border: 1px solid var(--slate);
  padding: .65rem;
  background: #f9fbf8;
  font: inherit;
}
button {
  background: var(--ink);
  color: #fff;
  border: 0;
  padding: .7rem 1rem;
  font-weight: 700;
  cursor: pointer;
}
button:hover { background: var(--slate); }
button:disabled { opacity: .5; cursor: not-allowed; }
.hide { display: none; }
.error { color: var(--alert); font-weight: 700; }
.admin { margin-top: 2rem; border-top: 3px solid var(--ink); padding-top: 1rem; }
.muted { color: #4e6068; font-size: .9rem; }
@media (max-width: 760px) {
  .grid { grid-template-columns: 1fr; padding-top: 2rem; }
  header { align-items: flex-start; gap: 1rem; flex-direction: column; }
}
`;

const body = `
<header>
  <div>
    <div class="stamp">Hermes agent registry · TLS pull channel</div>
    <h1>Hive Skills</h1>
  </div>
  <button id="logout" class="hide">Sign out</button>
</header>
<main class="grid">
  <section>
    <p class="intro">A registry that gives Hermes agents new working knowledge without changing the agent itself.
      Installed skills are pulled, verified, and refreshed by the host-side bridge.</p>
    <div class="card">
      <div class="stamp">Available to agents</div>
      <div id="skills">Loading catalog…</div>
    </div>
  </section>
  <aside>
    <section class="card" id="login">
      <div class="stamp">Operator access</div>
      <h2>Sign in with your host account</h2>
      <p class="muted">Authentication is checked against the server OS through PAM.</p>
      <form id="login-form">
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button>Sign in</button>
        <div class="error" id="login-error"></div>
      </form>
    </section>
    <section class="card hide" id="admin">
      <div class="stamp">Registry controls</div>
      <h2>Publish or deploy</h2>
      <p id="who" class="muted"></p>
      <form id="skill-form">
        <label>Skill slug<input name="slug" placeholder="my-skill" required></label>
        <label>Name<input name="name" required></label>
        <label>Description<textarea name="description" required></textarea></label>
        <label>Homepage (optional)<input name="homepage" type="url"></label>
        <button>Create skill</button>
      </form>
      <div class="admin">
        <label for="target">Deploy registry bridge to</label>
        <select id="target"></select>
        <button id="deploy" disabled>Deploy bridge</button>
        <p class="muted" id="result" role="status"></p>
        <pre id="jobs"></pre>
        <div class="admin">
          <h2>Release channels</h2>
          <form id="channel-form">
            <label>Skill slug<input name="slug" required></label>
            <label>Version<input name="version" required></label>
            <label>Channel<select name="channel"><option>canary</option><option>stable</option></select></label>
            <button>Promote release</button>
            <button type="button" id="withdraw">Withdraw from channel</button>
          </form>
          <pre id="channels"></pre>
          <h2>Agent receipts</h2>
          <p class="muted">Activated is an agent report. Discovery requires Hermes confirmation.</p>
          <pre id="receipts"></pre>
        </div>
      </div>
    </section>
  </aside>
</main>
`;

const script = `
const q = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let me = null;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(failure.error || response.statusText);
  }
  return response.status === 204 ? null : response.json();
}

async function catalog() {
  const skills = await api('/v1/skills');
  q('#skills').innerHTML = skills.length
    ? skills.map((s) => '<article class="skill"><i class="hex"></i><div><h2>' + esc(s.name) + '</h2><p>'
      + esc(s.description) + '</p><p class="muted">' + esc(s.slug) + '</p></div></article>').join('')
    : '<p>No skills have been published yet.</p>';
}

async function targets() {
  const select = q('#target');
  const list = (await api('/admin/targets')).filter((target) => target.enabled);
  select.innerHTML = list.length
    ? list.map((t) => '<option value="' + esc(t.name) + '">' + esc(t.name) + ' · ' + esc(t.username) + '@' + esc(t.host) + '</option>').join('')
    : '<option value="">No deployment targets configured</option>';
  q('#deploy').disabled = list.length === 0;
}

async function state() {
  try {
    me = await api('/auth/me');
    q('#login').classList.add('hide');
    q('#admin').classList.toggle('hide', !me.isAdmin);
    q('#logout').classList.remove('hide');
    q('#who').textContent = me.isAdmin
      ? 'Signed in as ' + me.username + '. You can manage the catalog.'
      : 'Signed in as ' + me.username + '. This account can browse only.';
    if (me.isAdmin) await targets();
  } catch {
    q('#login').classList.remove('hide');
  }
}

async function operations() {
  if (!me?.isAdmin) return;
  for (const [path, id] of [['deployments', 'jobs'], ['channels', 'channels'], ['receipts', 'receipts']]) {
    try {
      q('#' + id).textContent = JSON.stringify(await api('/admin/' + path), null, 2);
    } catch (err) {
      q('#result').textContent = err.message;
    }
  }
}

q('#login-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    await state();
    await operations();
  } catch (err) {
    q('#login-error').textContent = err.message;
  }
};

q('#logout').onclick = async () => {
  await api('/auth/logout', { method: 'POST' });
  location.reload();
};

q('#skill-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api('/admin/skills', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    event.target.reset();
    await catalog();
    q('#result').textContent = 'Skill created. Add a release through the API.';
  } catch (err) {
    q('#result').textContent = err.message;
  }
};

q('#deploy').onclick = async () => {
  const target = q('#target').value;
  if (!target) return;
  try {
    const job = await api('/admin/deployments/' + encodeURIComponent(target), { method: 'POST', body: '{}' });
    q('#result').textContent = 'Deployment ' + job.id + ' queued for ' + job.target;
    await operations();
  } catch (err) {
    q('#result').textContent = err.message;
  }
};

q('#channel-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.target));
  try {
    await api('/admin/channels/' + form.channel + '/' + encodeURIComponent(form.slug), { method: 'PUT', body: JSON.stringify({ version: form.version }) });
    await operations();
  } catch (err) {
    q('#result').textContent = err.message;
  }
};

q('#withdraw').onclick = async () => {
  const form = Object.fromEntries(new FormData(q('#channel-form')));
  try {
    await api('/admin/channels/' + form.channel + '/' + encodeURIComponent(form.slug), { method: 'DELETE' });
    await operations();
  } catch (err) {
    q('#result').textContent = err.message;
  }
};

catalog();
state().then(operations);
setInterval(operations, 5000);
`;

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hive Skills Registry</title>
<style>${styles}</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>`;
