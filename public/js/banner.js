/* ============================================================
   AI Panel — баннер ошибок в начале страницы.
   ============================================================ */

import { $id } from './dom.js';

let $banner, $bannerText;

export function initBanner() {
  $banner = $id('banner');
  $bannerText = $id('banner-text');
  const close = $id('banner-close');
  if (close) close.addEventListener('click', hideBanner);
}

export function showBanner(msg) {
  if (!$banner) return;
  $bannerText.textContent = msg;
  $banner.hidden = false;
}

export function hideBanner() {
  if ($banner) $banner.hidden = true;
}
