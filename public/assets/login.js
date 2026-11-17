'use strict';
document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('loginError');
  const button = event.target.querySelector('button');
  error.hidden = true;
  button.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (response.ok) return location.reload();
    error.textContent = (await response.json()).error || 'Sign-in failed.';
  } catch {
    error.textContent = 'Could not reach the server.';
  }
  error.hidden = false;
  button.disabled = false;
});
