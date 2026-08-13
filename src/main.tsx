import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/theme.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing from index.html');

/**
 * Takes down the launch screen from index.html.
 *
 * Called once the app has real data rather than on mount: handing over to a
 * screen full of skeletons is the same wait with worse manners. A timer backs
 * it up so a failure to load can never leave the loader stuck over a working
 * app — better to show an empty state than an eternal spinner.
 */
let bootDismissed = false;
export function dismissBoot(): void {
  if (bootDismissed) return;
  bootDismissed = true;
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.dataset.leaving = 'true';
  window.setTimeout(() => boot.remove(), 320);
}

window.setTimeout(dismissBoot, 8000);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
