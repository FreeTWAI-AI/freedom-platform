(function () {
  var root = document.querySelector('[data-code][data-target]');
  if (!root) return;
  var code = root.getAttribute('data-code') || '';
  var target = root.getAttribute('data-target') || '';
  function allowed(value) {
    if (!value || value.indexOf('\\') !== -1) return false;
    if (value.charAt(0) === '/' && value.charAt(1) !== '/') {
      try { return new URL(value, location.origin).origin === location.origin; } catch (error) { return false; }
    }
    if (value.indexOf('https://') === 0) {
      try { return new URL(value).href === value; } catch (error) { return false; }
    }
    return false;
  }
  var done = false;
  function go() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (allowed(target)) location.replace(target);
  }
  var timer = setTimeout(go, 1200);
  fetch('/api/v1/promotion/clicks', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: code }),
  }).then(go, go);
}());
