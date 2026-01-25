<script setup lang="ts">
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import type { GraphNode, GraphEdge } from '~/composables/useEntityGraph';
import { getRelationLabel } from '~/composables/useEntityGraph';

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  centralEntityId: string;
}>();

const emit = defineEmits<{
  (e: 'nodeClick', nodeId: string): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const network = ref<Network | null>(null);

// Node colors by entity type
const nodeColors = {
  person: {
    background: '#6366f1', // indigo
    border: '#4f46e5',
    highlight: { background: '#818cf8', border: '#6366f1' },
  },
  organization: {
    background: '#10b981', // emerald
    border: '#059669',
    highlight: { background: '#34d399', border: '#10b981' },
  },
};

// Edge colors by relation type
const edgeColors: Record<string, string> = {
  employment: '#f59e0b',   // amber
  reporting: '#ef4444',    // red
  team: '#8b5cf6',         // violet
  marriage: '#ec4899',     // pink
  parenthood: '#14b8a6',   // teal
  siblinghood: '#06b6d4',  // cyan
  friendship: '#22c55e',   // green
  acquaintance: '#64748b', // slate
  partnership: '#f97316',  // orange
  client_vendor: '#3b82f6', // blue
};

function initNetwork() {
  if (!containerRef.value) return;

  // Create nodes dataset
  const nodesData = new DataSet(
    props.nodes.map((node) => ({
      id: node.id,
      label: node.name,
      shape: node.type === 'person' ? 'dot' : 'diamond',
      size: node.id === props.centralEntityId ? 30 : 20,
      color: nodeColors[node.type],
      font: {
        color: '#1f2937',
        size: 14,
        face: 'Inter, system-ui, sans-serif',
      },
      borderWidth: node.id === props.centralEntityId ? 3 : 2,
    }))
  );

  // Create edges dataset
  const edgesData = new DataSet(
    props.edges.map((edge) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      label: getRelationLabel(edge.relationType),
      color: {
        color: edgeColors[edge.relationType] || '#94a3b8',
        highlight: edgeColors[edge.relationType] || '#94a3b8',
      },
      font: {
        color: '#6b7280',
        size: 11,
        strokeWidth: 0,
        face: 'Inter, system-ui, sans-serif',
      },
      arrows: {
        to: { enabled: false },
      },
      width: 2,
      smooth: {
        enabled: true,
        type: 'continuous',
        roundness: 0.5,
      },
    }))
  );

  // Network options
  const options = {
    nodes: {
      font: {
        color: '#1f2937',
      },
    },
    edges: {
      font: {
        align: 'middle',
      },
    },
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -3000,
        centralGravity: 0.3,
        springLength: 150,
        springConstant: 0.04,
        damping: 0.09,
      },
      stabilization: {
        iterations: 100,
        fit: true,
      },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true,
    },
    layout: {
      improvedLayout: true,
    },
  };

  // Destroy existing network
  if (network.value) {
    network.value.destroy();
  }

  // Create new network
  network.value = new Network(containerRef.value, { nodes: nodesData, edges: edgesData }, options);

  // Handle node click
  network.value.on('click', (params) => {
    if (params.nodes.length > 0) {
      emit('nodeClick', params.nodes[0] as string);
    }
  });
}

// Watch for data changes
watch(
  () => [props.nodes, props.edges, props.centralEntityId],
  () => {
    nextTick(() => {
      initNetwork();
    });
  },
  { deep: true }
);

// Initialize on mount
onMounted(() => {
  initNetwork();
});

// Cleanup on unmount
onUnmounted(() => {
  if (network.value) {
    network.value.destroy();
    network.value = null;
  }
});

// Expose fit method for parent component
function fit() {
  network.value?.fit();
}

defineExpose({ fit });
</script>

<template>
  <div class="entity-graph-container">
    <div ref="containerRef" class="graph-canvas" />

    <!-- Legend -->
    <div class="graph-legend">
      <div class="legend-section">
        <span class="legend-title">Типы:</span>
        <div class="legend-item">
          <span class="legend-dot bg-indigo-500" />
          <span>Человек</span>
        </div>
        <div class="legend-item">
          <span class="legend-diamond bg-emerald-500" />
          <span>Организация</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.entity-graph-container {
  position: relative;
  width: 100%;
  height: 400px;
  border-radius: 0.5rem;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border: 1px solid #e2e8f0;
}

.graph-canvas {
  width: 100%;
  height: 100%;
}

.graph-legend {
  position: absolute;
  bottom: 0.5rem;
  left: 0.5rem;
  background: rgba(255, 255, 255, 0.9);
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  display: flex;
  gap: 1rem;
  border: 1px solid #e2e8f0;
}

.legend-section {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.legend-title {
  font-weight: 500;
  color: #4b5563;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: #6b7280;
}

.legend-dot {
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
}

.legend-diamond {
  width: 0.625rem;
  height: 0.625rem;
  transform: rotate(45deg);
}

/* Dark mode support */
:global(.dark) .entity-graph-container {
  background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
  border-color: #334155;
}

:global(.dark) .graph-legend {
  background: rgba(30, 41, 59, 0.9);
  border-color: #334155;
}

:global(.dark) .legend-title {
  color: #d1d5db;
}

:global(.dark) .legend-item {
  color: #9ca3af;
}
</style>
