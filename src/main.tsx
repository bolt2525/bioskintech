/**
 * @file src/main.tsx
 * @description Punto de entrada del Admin Panel BIOSKIN.
 * Monta <App /> en el nodo #root del index.html.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
