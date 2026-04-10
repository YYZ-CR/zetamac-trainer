let currentUser = null;

// ── Init ─────────────────────────────────────────────────────

async function initAuth(callbacks = {}) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user ?? null;

  supabaseClient.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user ?? null;
    if (callbacks.onAuthChange) callbacks.onAuthChange(currentUser, event);
  });

  return currentUser;
}

// ── Auth modal ───────────────────────────────────────────────

function createAuthModal() {
  if (document.getElementById('auth-modal')) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'auth-modal';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
      <h2 id="modal-heading">Log In</h2>
      <input type="email" id="auth-email" class="auth-field" placeholder="Email" autocomplete="email">
      <input type="password" id="auth-password" class="auth-field" placeholder="Password" autocomplete="current-password">
      <input type="text" id="auth-username" class="auth-field" placeholder="Username" autocomplete="username" style="display:none">
      <div class="auth-error" id="auth-error" role="alert"></div>
      <button class="auth-submit" id="auth-submit-btn">Log In</button>
      <button class="auth-switch" id="auth-switch-btn">Don't have an account? Register</button>
    </div>
  `;
  document.body.appendChild(overlay);

  let isRegister = false;

  const close = () => { overlay.style.display = 'none'; };

  document.getElementById('modal-close-btn').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('auth-switch-btn').addEventListener('click', () => {
    isRegister = !isRegister;
    document.getElementById('modal-heading').textContent = isRegister ? 'Register' : 'Log In';
    document.getElementById('auth-submit-btn').textContent = isRegister ? 'Create Account' : 'Log In';
    document.getElementById('auth-switch-btn').textContent = isRegister
      ? 'Already have an account? Log in'
      : "Don't have an account? Register";
    document.getElementById('auth-username').style.display = isRegister ? 'block' : 'none';
    document.getElementById('auth-error').textContent = '';
  });

  overlay.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('auth-submit-btn').click();
    if (e.key === 'Escape') close();
  });

  document.getElementById('auth-submit-btn').addEventListener('click', async () => {
    const email    = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl  = document.getElementById('auth-error');
    const submitBtn = document.getElementById('auth-submit-btn');

    errorEl.textContent = '';

    if (!email || !password) {
      errorEl.textContent = 'Please enter your email and password.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isRegister ? 'Creating…' : 'Logging in…';

    try {
      if (isRegister) {
        const username = document.getElementById('auth-username').value.trim();
        if (!username) {
          errorEl.textContent = 'Please choose a username.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
          return;
        }

        // Check username availability
        const { data: existing } = await supabase
          .from('profiles')
          .select('username')
          .eq('username', username)
          .maybeSingle();

        if (existing) {
          errorEl.textContent = 'That username is already taken.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
          return;
        }

        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;

        if (data.user) {
          await createProfile(data.user.id, username);
          await claimSessions(data.user.id);
        }
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.user) await claimSessions(data.user.id);
      }

      close();
    } catch (err) {
      errorEl.textContent = err.message || 'Something went wrong.';
      submitBtn.disabled = false;
      submitBtn.textContent = isRegister ? 'Create Account' : 'Log In';
    }
  });
}

function showAuthModal(mode = 'login') {
  const overlay = document.getElementById('auth-modal');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const heading = document.getElementById('modal-heading');
  const isCurrentlyRegister = heading?.textContent === 'Register';
  if (mode === 'register' && !isCurrentlyRegister) {
    document.getElementById('auth-switch-btn')?.click();
  } else if (mode === 'login' && isCurrentlyRegister) {
    document.getElementById('auth-switch-btn')?.click();
  }
  // Focus first empty field
  setTimeout(() => {
    const email = document.getElementById('auth-email');
    if (email) email.focus();
  }, 50);
}

function hideAuthModal() {
  const overlay = document.getElementById('auth-modal');
  if (overlay) overlay.style.display = 'none';
}

// ── Auth bar ─────────────────────────────────────────────────

async function logout() {
  await supabaseClient.auth.signOut();
  currentUser = null;
}

function renderAuthBar(user, container) {
  if (!container) return;
  if (user) {
    container.innerHTML = `
      <a href="dashboard.html">Dashboard</a>
      <span class="sep">|</span>
      <button class="link-btn" id="logout-btn">Log out</button>
    `;
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await logout();
      window.location.reload();
    });
  } else {
    container.innerHTML = `
      <a href="dashboard.html">Dashboard</a>
      <span class="sep">|</span>
      <button class="link-btn" id="login-btn">Log in</button>
      <span class="sep">|</span>
      <button class="link-btn" id="register-btn">Register</button>
    `;
    document.getElementById('login-btn').addEventListener('click', () => showAuthModal('login'));
    document.getElementById('register-btn').addEventListener('click', () => showAuthModal('register'));
  }
}
