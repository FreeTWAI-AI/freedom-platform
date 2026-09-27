import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './rpg-theme.css'
import './LayoutDesign.css'
import './light-theme.css'

try { document.documentElement.dataset.theme = localStorage.getItem('freedom-theme') === 'dark' ? 'dark' : 'light' }
catch { document.documentElement.dataset.theme = 'light' }

const root = document.getElementById('root')
if (!root) {
  throw new Error('找不到根節點')
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
