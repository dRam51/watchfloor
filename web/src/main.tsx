import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from web/index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
