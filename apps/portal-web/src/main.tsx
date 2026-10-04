import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './rpg-theme.css'
import './LayoutDesign.css'
import './GameConsole.css'
import './light-theme.css'
import './versefolk-theme.css'
import './module-light-theme.css'
import './GameConsoleThemes.css'
import './CalmExperience.css'

import {initializeExperienceProfile} from './experience-profiles'
import './dragon-theme.css'

initializeExperienceProfile()

const root = document.getElementById('root')
if (!root) {
  throw new Error('找不到根節點')
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
