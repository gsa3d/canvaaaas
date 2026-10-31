import '@fontsource-variable/golos-text';
import { render } from 'preact';
import { App } from './App.tsx';
import { loadPrefs } from './api.ts';
import './styles.css';

// Настройки — до первой отрисовки: из них начальные значения формы и инструментов
void loadPrefs().then(() => render(<App />, document.getElementById('root')!));
