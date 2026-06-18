'use strict';

/*
 * Runs before first paint. The live SMTP form can only work when this page is
 * served by the local checker (it needs the local backend to open the SMTP
 * connection). On the public landing page there is no backend, so we mark the
 * document as local-only when served from loopback and let CSS reveal the form.
 */
(function () {
  var host = location.hostname;
  var isLocal =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '';
  if (isLocal) {
    var el = document.documentElement;
    el.className = el.className ? el.className + ' is-local' : 'is-local';
  }
})();
