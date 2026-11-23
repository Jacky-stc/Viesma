import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Playground } from './playground/playground'
import './playground/playground.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Missing Viesma root element')
}

createRoot(container).render(
  <StrictMode>
    <Playground />
  </StrictMode>
)
