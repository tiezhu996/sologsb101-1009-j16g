import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { ConfigProvider } from '@arco-design/web-react'
import zhCN from '@arco-design/web-react/es/locale/zh-CN'
import '@arco-design/web-react/dist/css/arco.css'
import './styles/main.css'
import { appRoutes } from './router'
import { initDatabase, stampDbVersion } from './utils/db'
import { resumeInterruptedReplacements } from './utils/replacementRunner'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载节点')
}

const router = createBrowserRouter(appRoutes)

stampDbVersion()

// 首屏先完成 IndexedDB 打开与演示数据播种，再渲染应用，避免列表页空窗；
// 随后接着上次进度恢复写入中断的设备更换（已复制点位不重复，已登记/待投运属正常停顿不自动推进）。
void initDatabase()
  .then(() => resumeInterruptedReplacements())
  .catch((error: unknown) => {
    console.error('本地数据库初始化失败', error)
  })
  .finally(() => {
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        <ConfigProvider locale={zhCN}>
          <RouterProvider router={router} />
        </ConfigProvider>
      </React.StrictMode>
    )
  })
