import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
/**
 * Imported for its side effect, and the order on this page is the whole point.
 *
 * The client installs the one `message` listener at module scope, so it is
 * listening as part of this bundle being evaluated — which is before React has
 * rendered anything, let alone run an effect. The host greets on the frame's
 * `load` event, and effects run strictly after that, so a listener installed in
 * `useEffect` is installed after the greeting has already been posted and thrown
 * away. See the essay in the client's `mailbox.ts`; it is a bug that costs an
 * afternoon and whose only symptom is a container reporting a module that will
 * not speak.
 *
 * It is imported HERE, from the entry, rather than from wherever `connect` is
 * called — a module scope that only a lazily-loaded chunk imports is a module
 * scope that has not run yet, which is the same bug wearing a bundler's clothes.
 */
import 'roadmap-module-protocol/client'
import { App } from './app.tsx'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
