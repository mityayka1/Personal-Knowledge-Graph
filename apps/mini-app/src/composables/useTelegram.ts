import { computed, ref, onUnmounted } from 'vue'

const webApp = window.Telegram?.WebApp

export function useTelegram() {
  const isAvailable = computed(() => !!webApp)
  const user = computed(() => webApp?.initDataUnsafe?.user)
  const initData = computed(() => webApp?.initData || '')
  const colorScheme = ref<'light' | 'dark'>(webApp?.colorScheme || 'light')
  const startParam = computed(() => webApp?.initDataUnsafe?.start_param)

  return {
    webApp,
    isAvailable,
    user,
    initData,
    colorScheme,
    startParam,
  }
}

export function useMainButton() {
  const mainButton = webApp?.MainButton

  const show = () => mainButton?.show()
  const hide = () => mainButton?.hide()
  const enable = () => mainButton?.enable()
  const disable = () => mainButton?.disable()
  const setText = (text: string) => mainButton?.setText(text)
  const showProgress = (leaveActive = false) => mainButton?.showProgress(leaveActive)
  const hideProgress = () => mainButton?.hideProgress()

  let currentCallback: (() => void) | null = null

  const onClick = (callback: () => void) => {
    if (currentCallback && mainButton) {
      mainButton.offClick(currentCallback)
    }
    currentCallback = callback
    mainButton?.onClick(callback)
  }

  const offClick = () => {
    if (currentCallback && mainButton) {
      mainButton.offClick(currentCallback)
      currentCallback = null
    }
  }

  onUnmounted(() => {
    offClick()
    hide()
  })

  return {
    show,
    hide,
    enable,
    disable,
    setText,
    showProgress,
    hideProgress,
    onClick,
    offClick,
  }
}

export function useBackButton() {
  const backButton = webApp?.BackButton

  const show = () => backButton?.show()
  const hide = () => backButton?.hide()

  let currentCallback: (() => void) | null = null

  const onClick = (callback: () => void) => {
    if (currentCallback && backButton) {
      backButton.offClick(currentCallback)
    }
    currentCallback = callback
    backButton?.onClick(callback)
  }

  const offClick = () => {
    if (currentCallback && backButton) {
      backButton.offClick(currentCallback)
      currentCallback = null
    }
  }

  onUnmounted(() => {
    offClick()
  })

  return {
    show,
    hide,
    onClick,
    offClick,
  }
}

export function useHapticFeedback() {
  const haptic = webApp?.HapticFeedback

  const impactOccurred = (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => {
    haptic?.impactOccurred(style)
  }

  const notificationOccurred = (type: 'error' | 'success' | 'warning') => {
    haptic?.notificationOccurred(type)
  }

  const selectionChanged = () => {
    haptic?.selectionChanged()
  }

  return {
    impactOccurred,
    notificationOccurred,
    selectionChanged,
  }
}

export function usePopup() {
  const showPopup = (
    params: {
      title?: string
      message: string
      buttons?: Array<{
        id?: string
        type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive'
        text?: string
      }>
    },
    callback?: (buttonId: string) => void
  ) => {
    webApp?.showPopup(params, callback)
  }

  const showAlert = (message: string): Promise<void> => {
    return new Promise((resolve) => {
      webApp?.showAlert(message, resolve)
    })
  }

  const showConfirm = (message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      webApp?.showConfirm(message, resolve)
    })
  }

  return {
    showPopup,
    showAlert,
    showConfirm,
  }
}
