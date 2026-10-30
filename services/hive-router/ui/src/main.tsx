import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { ToastProvider } from './components/toast';
import './styles/app.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
