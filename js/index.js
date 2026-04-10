document.addEventListener('DOMContentLoaded', async () => {
  createAuthModal();

  const user = await initAuth({
    onAuthChange: (u) => renderAuthBar(u, document.getElementById('top-bar')),
  });
  renderAuthBar(user, document.getElementById('top-bar'));

  // Pre-fill form if a config key is in the URL
  const params = new URLSearchParams(window.location.search);
  const keyParam = params.get('key');
  if (keyParam) {
    const cached = sessionStorage.getItem('config_' + keyParam);
    if (cached) {
      loadConfigIntoForm(JSON.parse(cached));
    } else {
      try {
        const config = await getConfig(keyParam);
        if (config) loadConfigIntoForm(config);
      } catch (_) { /* use defaults */ }
    }
  }

  document.getElementById('start-btn').addEventListener('click', async () => {
    const config = readFormConfig();

    if (config.operations.length === 0) {
      alert('Please select at least one operation.');
      return;
    }

    const btn = document.getElementById('start-btn');
    btn.disabled = true;
    btn.textContent = 'Starting…';

    let key;
    try {
      key = await saveConfig(config);
    } catch (_) {
      // Supabase unavailable — generate key locally
      key = await hashToKey(JSON.stringify(config));
    }

    sessionStorage.setItem('config_' + key, JSON.stringify(config));
    window.location.href = 'game.html?key=' + key;
  });
});

function readFormConfig() {
  return {
    operations: [
      document.getElementById('op-addition').checked      && 'addition',
      document.getElementById('op-subtraction').checked   && 'subtraction',
      document.getElementById('op-multiplication').checked && 'multiplication',
      document.getElementById('op-division').checked      && 'division',
    ].filter(Boolean),
    addMin1: +document.getElementById('add-min1').value || 2,
    addMax1: +document.getElementById('add-max1').value || 100,
    addMin2: +document.getElementById('add-min2').value || 2,
    addMax2: +document.getElementById('add-max2').value || 100,
    mulMin1: +document.getElementById('mul-min1').value || 2,
    mulMax1: +document.getElementById('mul-max1').value || 12,
    mulMin2: +document.getElementById('mul-min2').value || 2,
    mulMax2: +document.getElementById('mul-max2').value || 100,
    duration: +document.getElementById('duration').value || 120,
  };
}

function loadConfigIntoForm(c) {
  if (c.operations) {
    document.getElementById('op-addition').checked      = c.operations.includes('addition');
    document.getElementById('op-subtraction').checked   = c.operations.includes('subtraction');
    document.getElementById('op-multiplication').checked = c.operations.includes('multiplication');
    document.getElementById('op-division').checked      = c.operations.includes('division');
  }
  const map = {
    'add-min1': c.addMin1, 'add-max1': c.addMax1,
    'add-min2': c.addMin2, 'add-max2': c.addMax2,
    'mul-min1': c.mulMin1, 'mul-max1': c.mulMax1,
    'mul-min2': c.mulMin2, 'mul-max2': c.mulMax2,
    'duration': c.duration,
  };
  for (const [id, val] of Object.entries(map)) {
    if (val != null) document.getElementById(id).value = val;
  }
}
