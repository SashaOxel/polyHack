import { createRoot } from 'react-dom/client'
import { App } from './App'
import { store } from './core/store'
import './styles.css'

// В режиме разработки store доступен из консоли браузера: __store.doc.ways, __store.undo() ...
if (import.meta.env.DEV) (window as unknown as { __store: typeof store }).__store = store

createRoot(document.getElementById('root')!).render(<App />)
