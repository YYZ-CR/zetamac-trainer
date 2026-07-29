let currentUser = null;

// ── Init ─────────────────────────────────────────────────────

async function initAuth(callbacks = {}) {
  if (!supabaseClient) {
    console.warn('initAuth: supabaseClient not available');
    return null;
  }

  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) console.warn('getSession error:', error.message);
    currentUser = session?.user ?? null;
  } catch (e) {
    console.warn('initAuth: getSession threw', e);
    currentUser = null;
  }

  try {
    supabaseClient.auth.onAuthStateChange((event, session) => {
      currentUser = session?.user ?? null;
      if (callbacks.onAuthChange) callbacks.onAuthChange(currentUser, event);
    });
  } catch (e) {
    console.warn('initAuth: onAuthStateChange threw', e);
  }

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
      <input type="text" id="auth-username" class="auth-field" placeholder="Username — 3-20 letters, numbers, - or _" autocomplete="username" maxlength="20" style="display:none">
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

    if (!supabaseClient) {
      errorEl.textContent = 'Authentication is unavailable. Please check your connection.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isRegister ? 'Creating…' : 'Logging in…';

    try {
      if (isRegister) {
        const username = document.getElementById('auth-username').value.trim();

        // Checked here, before signUp, because profiles carries a CHECK
        // constraint on username shape. Without this the account is created,
        // the profile insert is refused, and the user is left signed in with
        // no username at all.
        const problem = typeof usernameProblem === 'function'
          ? usernameProblem(username)
          : (username ? null : 'Please choose a username.');
        if (problem) {
          errorEl.textContent = problem;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
          return;
        }

        // Check username availability. Once hardening.sql is applied, profiles
        // is owner-readable only, so this goes through a SECURITY DEFINER
        // function; before that the direct read still works.
        if (!(await isUsernameAvailable(username))) {
          errorEl.textContent = 'That username is already taken.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
          return;
        }

        // The username travels WITH the registration, as signUp's
        // options.data — GoTrue stores it on auth.users.raw_user_meta_data and
        // supabase/signup.sql's trigger writes the profile from there, inside
        // the same transaction that creates the account.
        //
        // It used to be written here instead, by a separate insert after
        // signUp returned. That insert is checked by RLS against auth.uid(),
        // and with email confirmation enabled signUp returns a user but NO
        // session — so it was refused, the typed username was dropped, and the
        // account went on to play the daily with no profile row at all, where
        // get_global_board correctly refuses to rank it.
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { data: { username } }
        });
        if (error) throw error;

        if (data.user) {
          // Only one of the two outcomes can be checked from here.
          //
          // With a session, the profile the trigger just wrote is readable, so
          // verify it — and fall back to the old client-side insert if it is
          // absent, because the client has to work on both sides of signup.sql
          // being applied. A failure now is real and worth reporting: the
          // likeliest cause is the name being taken between the availability
          // check above and this call, and the UNIQUE index, not that check,
          // is what decides.
          //
          // Without a session there is nothing to verify: profiles is
          // owner-readable and this browser is nobody yet. The trigger is the
          // entire mechanism in that case, which is the point of moving it
          // server-side — the insert this replaced could never have run here.
          if (data.session) {
            const profile = await getProfile(data.user.id);
            if (!profile && !(await createProfile(data.user.id, username))) {
              errorEl.textContent =
                'Account created, but that username could not be saved — it may have just been taken. You can set one in Settings.';
            }
          }
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
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
}

// The one header builder. There used to be two — this one, which rendered
// Dashboard and never Play, and a hand-rolled copy in js/dashboard.js which
// rendered Play and never Dashboard. The result was that exactly one of the
// two appeared depending on which page you were on, which reads as links
// randomly disappearing. Every page calls this now; if a page needs a
// different link, it belongs in NAV, not in a second copy of this function.
// Game modes first, then the account. Duel and Leaderboards live here rather
// than on the config page because they are places you go, not options you set
// before pressing Start — and a mode buried behind Play is a mode nobody
// discovers.
//
// The Leaderboards item still points at leagues.html: the page was renamed,
// the file was not, because every invite link already sent carries that name.
// docs/leaderboards-design.md has the reasoning.
const NAV = [
  { href: 'index.html',     label: 'Play' },
  { href: 'duel.html',      label: 'Duel' },
  { href: 'leagues.html',   label: 'Leaderboards' },
  { href: 'dashboard.html', label: 'Dashboard' },
  // Nothing to configure without an account, so this one is conditional.
  { href: 'settings.html',  label: 'Settings', authOnly: true },
];

// Which file is being viewed, so the current page can be marked rather than
// linking to itself. A clean URL (/@name, /d/key) has no .html basename, so
// nothing matches and nothing is marked — which is correct.
function currentPageFile() {
  const last = String(window.location.pathname).split('/').pop() || 'index.html';
  return last === '' ? 'index.html' : last;
}

function renderAuthBar(user, container) {
  if (!container) return;

  const here  = currentPageFile();
  const links = NAV
    .filter(item => !item.authOnly || user)
    .map(item => item.href === here
      ? `<span class="nav-current" aria-current="page">${item.label}</span>`
      : `<a href="${item.href}">${item.label}</a>`);

  const account = user
    ? '<button class="link-btn" id="logout-btn">Log out</button>'
    : '<button class="link-btn" id="login-btn">Log in</button>' +
      '<span class="sep">|</span>' +
      '<button class="link-btn" id="register-btn">Register</button>';

  container.innerHTML = [...links, account].join('<span class="sep">|</span>');

  if (user) {
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await logout();
      // The dashboard's old copy omitted this, so logging out there left a
      // signed-out page still showing the previous user's data until reload.
      window.location.reload();
    });
  } else {
    document.getElementById('login-btn').addEventListener('click', () => showAuthModal('login'));
    document.getElementById('register-btn').addEventListener('click', () => showAuthModal('register'));
  }

  // Appended last: the innerHTML assignment above would wipe it out.
  if (typeof renderThemeToggle === 'function') renderThemeToggle(container);
}
