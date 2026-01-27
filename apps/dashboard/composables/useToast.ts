import { ref, computed } from 'vue';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
  duration?: number;
}

const toasts = ref<Toast[]>([]);
let toastIdCounter = 0;

export function useToast() {
  function toast(options: Omit<Toast, 'id'>) {
    const id = `toast-${++toastIdCounter}`;
    const newToast: Toast = {
      ...options,
      id,
      duration: options.duration ?? 5000,
    };

    toasts.value.push(newToast);

    // Auto-remove after duration
    const duration = newToast.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => {
        dismiss(id);
      }, duration);
    }

    return { id, dismiss: () => dismiss(id) };
  }

  function dismiss(id: string) {
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) {
      toasts.value.splice(index, 1);
    }
  }

  function dismissAll() {
    toasts.value = [];
  }

  return {
    toasts: computed(() => toasts.value),
    toast,
    dismiss,
    dismissAll,
  };
}
