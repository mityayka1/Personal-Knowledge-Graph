<script setup lang="ts">
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, type DialogContentEmits, type DialogContentProps, useForwardPropsEmits } from 'radix-vue';
import { X } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

const props = defineProps<DialogContentProps & { class?: string }>();
const emits = defineEmits<DialogContentEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <ClientOnly>
    <Teleport to="body">
      <DialogPortal disabled>
        <DialogOverlay
          class="fixed inset-0 z-50 bg-black/80"
        />
        <DialogContent
          v-bind="forwarded"
          :class="cn(
            'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg sm:rounded-lg',
            props.class
          )"
        >
          <slot />
          <DialogClose
            class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          >
            <X class="h-4 w-4" />
            <span class="sr-only">Close</span>
          </DialogClose>
        </DialogContent>
      </DialogPortal>
    </Teleport>
  </ClientOnly>
</template>
