import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles/main.css'

// Initialize Telegram Web App
const webApp = window.Telegram?.WebApp
if (webApp) {
  webApp.ready()
  webApp.expand()
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('./pages/index.vue'),
    },
    {
      path: '/brief/:briefId',
      name: 'brief',
      component: () => import('./pages/brief/[briefId].vue'),
    },
    {
      path: '/recall/:sessionId',
      name: 'recall',
      component: () => import('./pages/recall/[sessionId].vue'),
    },
    {
      path: '/entity/:entityId',
      name: 'entity',
      component: () => import('./pages/entity/[entityId].vue'),
    },
    {
      path: '/pending-approval/:batchId',
      name: 'pending-approval',
      component: () => import('./pages/pending-approval/[batchId].vue'),
    },
  ],
})

// Handle Telegram start_param for deep links
router.beforeEach((to, _from, next) => {
  if (to.path === '/' && webApp?.initDataUnsafe?.start_param) {
    const startParam = webApp.initDataUnsafe.start_param
    const [type, ...idParts] = startParam.split('_')
    const id = idParts.join('_')

    if (type && id) {
      const routeMap: Record<string, string> = {
        brief: `/brief/${id}`,
        recall: `/recall/${id}`,
        entity: `/entity/${id}`,
        approval: `/pending-approval/${id}`,
      }

      const route = routeMap[type]
      if (route) {
        next(route)
        return
      }
    }
  }
  next()
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
