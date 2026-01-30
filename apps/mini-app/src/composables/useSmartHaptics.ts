import { useHapticFeedback } from './useTelegram'

/**
 * Smart haptics composable that provides semantic haptic feedback patterns
 * for common UI interactions in the Mini App.
 */
export function useSmartHaptics() {
  const haptic = useHapticFeedback()

  /**
   * Feedback for confirming an action (like approving an extracted event)
   */
  const confirm = () => {
    haptic.notificationOccurred('success')
  }

  /**
   * Feedback for skipping or dismissing an item
   */
  const skip = () => {
    haptic.impactOccurred('light')
  }

  /**
   * Feedback for destructive actions (like rejecting)
   */
  const reject = () => {
    haptic.notificationOccurred('warning')
  }

  /**
   * Feedback for errors
   */
  const error = () => {
    haptic.notificationOccurred('error')
  }

  /**
   * Feedback for button taps
   */
  const tap = () => {
    haptic.impactOccurred('medium')
  }

  /**
   * Feedback for selection changes (like swiping carousel)
   */
  const selection = () => {
    haptic.selectionChanged()
  }

  /**
   * Feedback for completing a sequence (like finishing all items)
   */
  const complete = () => {
    haptic.notificationOccurred('success')
  }

  /**
   * Feedback for navigation
   */
  const navigate = () => {
    haptic.impactOccurred('light')
  }

  /**
   * Feedback for pull-to-refresh
   */
  const refresh = () => {
    haptic.impactOccurred('medium')
  }

  return {
    confirm,
    skip,
    reject,
    error,
    tap,
    selection,
    complete,
    navigate,
    refresh,
  }
}
