import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { registerServiceWorker } from './registerServiceWorker.ts';
import './styles/tokens.css';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from web/index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// M6. Offline read, production builds only -- see registerServiceWorker.ts for
// why dev is excluded and why a failure here is not an error.
registerServiceWorker();
