import '@fontsource-variable/golos-text';
import { render } from 'preact';
import { loadLang, loadPrefs } from './api.ts';
import './styles.css';

// Язык и настройки — до первой отрисовки: из них тексты, начальные значения формы и инструментов.
// Интерфейс грузится после: его подписи считаются при загрузке модуля на уже выбранном языке
void Promise.all([loadLang(), loadPrefs()])
  .then(() => import('./App.tsx'))
  .then(({ App }) => render(<App />, document.getElementById('root')!));
