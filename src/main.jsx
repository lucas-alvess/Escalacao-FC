import { createRoot } from 'react-dom/client';
import App from './app.jsx';

// Bloqueia menu de contexto em imagens (mobile e desktop)
document.addEventListener('contextmenu', e => {
  if (e.target.closest('img')) e.preventDefault();
}, true);

const root = createRoot(document.getElementById('root'));
root.render(<App />);
document.getElementById('loading').style.display = 'none';
