// 全局样式必须最先导入：顺序为 tokens → @rakko/react 样式 → 本应用样式（见 styles/app.css）。
import './styles/app.css'

import { Snackbar, installTheme } from '@rakko/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root 挂载点')

// 首帧主题已由 index.html 里注入的 themeBootScript 定好，这里接管之后的系统明暗变化与手动切换
installTheme()

createRoot(root).render(
  <StrictMode>
    <Snackbar.Provider>
      <App />
    </Snackbar.Provider>
  </StrictMode>,
)
