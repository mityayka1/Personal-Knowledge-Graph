<script setup lang="ts">
import { ref, computed } from 'vue';
import { GitMerge, CheckCircle2, Plus } from 'lucide-vue-next';
import {
  useMergeSuggestions,
  useDismissSuggestion,
  useMergePreview,
  useExecuteMerge,
  type MergeRequestDto,
} from '~/composables/useMergeSuggestions';
import { useToast } from '~/composables/useToast';

definePageMeta({
  title: 'Запросы на слияние',
});

const { toast } = useToast();

// Data fetching
const params = computed(() => ({ limit: 50, offset: 0 }));
const { data, isLoading, error, refetch } = useMergeSuggestions(params);
const dismissMutation = useDismissSuggestion();
const mergeMutation = useExecuteMerge();

// Manual merge dialog state
const showManualMergeDialog = ref(false);

// Merge preview dialog state
const showPreviewDialog = ref(false);
const previewSourceId = ref('');
const previewTargetId = ref('');

const {
  data: previewData,
  isLoading: previewLoading,
  refetch: refetchPreview,
} = useMergePreview(previewSourceId, previewTargetId);

// Track loading state per candidate
const loadingCandidates = ref<Set<string>>(new Set());

async function handleDismiss(primaryId: string, candidateId: string) {
  loadingCandidates.value.add(candidateId);
  try {
    await dismissMutation.mutateAsync({ primaryId, candidateId });
    toast({
      title: 'Предложение отклонено',
      description: 'Эти сущности не будут предлагаться к слиянию',
    });
  } catch (e) {
    toast({
      title: 'Ошибка',
      description: 'Не удалось отклонить предложение',
      variant: 'destructive',
    });
  } finally {
    loadingCandidates.value.delete(candidateId);
  }
}

function openMergePreview(sourceId: string, targetId: string) {
  previewSourceId.value = sourceId;
  previewTargetId.value = targetId;
  showPreviewDialog.value = true;
  refetchPreview();
}

function handleManualMergeSelect(sourceId: string, targetId: string) {
  showManualMergeDialog.value = false;
  openMergePreview(sourceId, targetId);
}

async function handleMergeConfirm(request: MergeRequestDto) {
  try {
    const result = await mergeMutation.mutateAsync(request);
    showPreviewDialog.value = false;
    toast({
      title: 'Сущности объединены',
      description: `Перенесено: ${result.identifiersMoved} идентификаторов, ${result.factsMoved} фактов`,
    });
    refetch();
  } catch (e) {
    toast({
      title: 'Ошибка',
      description: 'Не удалось объединить сущности',
      variant: 'destructive',
    });
  }
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Запросы на слияние</h1>
        <p class="text-muted-foreground">
          Обнаруженные дубликаты сущностей для объединения
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge v-if="data?.total" variant="secondary">
          {{ data.total }} {{ data.total === 1 ? 'группа' : 'групп' }}
        </Badge>
        <Button @click="showManualMergeDialog = true">
          <Plus class="h-4 w-4 mr-2" />
          Объединить вручную
        </Button>
      </div>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-destructive text-center py-8">
      Не удалось загрузить запросы на слияние. Попробуйте ещё раз.
    </div>

    <!-- Loading state -->
    <div v-else-if="isLoading" class="space-y-4">
      <Card v-for="i in 3" :key="i">
        <CardContent class="p-4">
          <div class="flex items-start gap-4">
            <Skeleton class="h-12 w-12 rounded-full" />
            <div class="space-y-2 flex-1">
              <Skeleton class="h-5 w-1/3" />
              <Skeleton class="h-4 w-1/2" />
              <div class="mt-4 space-y-2">
                <Skeleton class="h-16 w-full" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!data?.groups.length"
      class="text-center py-16 text-muted-foreground"
    >
      <CheckCircle2 class="h-16 w-16 mx-auto mb-4 text-green-500 opacity-50" />
      <p class="text-lg font-medium">Нет запросов на слияние</p>
      <p class="text-sm mt-1">Все сущности уникальны</p>
    </div>

    <!-- Suggestion groups -->
    <div v-else class="space-y-4">
      <MergeSuggestionCard
        v-for="group in data.groups"
        :key="group.primaryEntity.id"
        :group="group"
        :loading="loadingCandidates.has(group.primaryEntity.id)"
        @merge="(candidateId) => openMergePreview(candidateId, group.primaryEntity.id)"
        @dismiss="(candidateId) => handleDismiss(group.primaryEntity.id, candidateId)"
      />
    </div>

    <!-- Manual Merge Dialog -->
    <ManualMergeDialog
      v-model:open="showManualMergeDialog"
      @select="handleManualMergeSelect"
    />

    <!-- Merge Preview Dialog -->
    <MergePreviewDialog
      v-model:open="showPreviewDialog"
      :preview="previewData || null"
      :loading="mergeMutation.isPending.value"
      @close="showPreviewDialog = false"
      @confirm="handleMergeConfirm"
    />
  </div>
</template>
