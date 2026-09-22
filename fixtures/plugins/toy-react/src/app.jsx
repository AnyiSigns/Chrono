import { createRoot } from 'react-dom/client'

// 构建标记：改这一行即可在重新打包后观察到产物变化（端到端验证用）。
const BUILD_TAG = 'toy-react-build-v1'

function App() {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>toy-react</h1>
      <p data-build-tag="true">{BUILD_TAG}</p>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
