import './assets/main.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { P2PProvider } from './context/P2PContext'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <P2PProvider>
      <App />
    </P2PProvider>
  </StrictMode>
)
