import { useTelegram } from '@/composables/useTelegram'

const API_BASE = '/api/v1/mini-app'

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  signal?: AbortSignal
}

interface ApiError {
  status: number
  message: string
  details?: unknown
}

class ApiClient {
  private getInitData(): string {
    const { initData } = useTelegram()
    return initData.value
  }

  async request<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    const { method = 'GET', body, signal } = options

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const initData = this.getInitData()
    if (initData) {
      headers['Authorization'] = `tma ${initData}`
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })

    if (!response.ok) {
      const error: ApiError = {
        status: response.status,
        message: response.statusText,
      }

      try {
        error.details = await response.json()
      } catch {
        // Ignore JSON parse errors
      }

      throw error
    }

    return response.json()
  }

  // Dashboard
  async getMe() {
    return this.request<{
      user: { id: number; firstName: string; lastName?: string; username?: string }
      isOwner: boolean
    }>('/me')
  }

  async getDashboard() {
    return this.request<{
      pendingActions: Array<{
        type: 'extraction' | 'fact_conflict' | 'approval'
        id: string
        title: string
        count?: number
      }>
      todayBrief: {
        id: string
        itemCount: number
        completedCount: number
      } | null
      recentActivity: Array<{
        type: 'recall' | 'brief' | 'entity'
        id: string
        title: string
        timestamp: string
      }>
    }>('/dashboard')
  }

  // Brief
  async getBrief(briefId: string) {
    return this.request<{
      id: string
      date: string
      items: Array<{
        idx: number
        type: string
        title: string
        description: string
        priority: 'high' | 'medium' | 'low'
        completed: boolean
        entityId?: string
        entityName?: string
      }>
    }>(`/brief/${briefId}`)
  }

  async briefItemAction(briefId: string, itemIdx: number, action: string) {
    return this.request<{ success: boolean }>(`/brief/${briefId}/item/${itemIdx}/action`, {
      method: 'POST',
      body: { action },
    })
  }

  // Extraction Carousel
  async getExtraction(carouselId: string) {
    return this.request<{
      id: string
      items: Array<{
        id: string
        type: 'project' | 'commitment' | 'action_item' | 'deadline' | 'contact'
        title: string
        description?: string
        confidence: number
        fields: Record<string, unknown>
        status: 'pending' | 'confirmed' | 'skipped'
      }>
      currentIndex: number
      totalCount: number
      confirmedCount: number
      skippedCount: number
    }>(`/extraction/${carouselId}`)
  }

  async confirmExtraction(carouselId: string, itemId: string, edits?: Record<string, unknown>) {
    return this.request<{ success: boolean; nextIndex?: number }>(`/extraction/${carouselId}/confirm/${itemId}`, {
      method: 'POST',
      body: edits ? { edits } : undefined,
    })
  }

  async skipExtraction(carouselId: string, itemId: string, reason?: string) {
    return this.request<{ success: boolean; nextIndex?: number }>(`/extraction/${carouselId}/skip/${itemId}`, {
      method: 'POST',
      body: reason ? { reason } : undefined,
    })
  }

  // Recall Session
  async getRecall(sessionId: string) {
    return this.request<{
      id: string
      query: string
      answer: string
      sources: Array<{
        id: string
        type: 'message' | 'interaction' | 'fact'
        preview: string
        entityName?: string
        timestamp?: string
      }>
      createdAt: string
    }>(`/recall/${sessionId}`)
  }

  // Entity
  async getEntity(entityId: string) {
    return this.request<{
      id: string
      type: 'person' | 'organization'
      name: string
      avatarUrl?: string
      facts: Array<{
        type: string
        value: string
        updatedAt: string
      }>
      recentInteractions: Array<{
        id: string
        type: string
        summary?: string
        timestamp: string
      }>
      identifiers: Array<{
        type: string
        value: string
      }>
    }>(`/entity/${entityId}`)
  }

  // Pending Approvals
  async getPendingApprovals(params?: { batchId?: string; status?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams()
    if (params?.batchId) query.set('batchId', params.batchId)
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const queryString = query.toString()
    return this.request<{
      items: Array<{
        id: string
        itemType: 'fact' | 'project' | 'task' | 'commitment'
        targetId: string
        confidence: number
        sourceQuote: string | null
        status: 'pending' | 'approved' | 'rejected'
        createdAt: string
        target?: {
          name?: string
          title?: string
          value?: string
          factType?: string
        }
      }>
      total: number
      limit: number
      offset: number
    }>(`/pending-approval${queryString ? `?${queryString}` : ''}`)
  }

  async getPendingApproval(id: string) {
    return this.request<{
      id: string
      itemType: 'fact' | 'project' | 'task' | 'commitment'
      targetId: string
      confidence: number
      sourceQuote: string | null
      status: 'pending' | 'approved' | 'rejected'
      createdAt: string
      target?: {
        name?: string
        title?: string
        value?: string
        factType?: string
      }
    }>(`/pending-approval/${id}`)
  }

  async approvePendingApproval(id: string) {
    return this.request<{ success: boolean }>(`/pending-approval/${id}/approve`, {
      method: 'POST',
    })
  }

  async rejectPendingApproval(id: string) {
    return this.request<{ success: boolean }>(`/pending-approval/${id}/reject`, {
      method: 'POST',
    })
  }

  async getPendingApprovalBatchStats(batchId: string) {
    return this.request<{
      total: number
      pending: number
      approved: number
      rejected: number
    }>(`/pending-approval/batch/${batchId}/stats`)
  }

  async getPendingApprovalGlobalStats() {
    return this.request<{
      total: number
      pending: number
      approved: number
      rejected: number
    }>(`/pending-approval/stats`)
  }

  async approvePendingBatch(batchId: string) {
    return this.request<{ approved: number; errors: string[] }>(`/pending-approval/batch/${batchId}/approve`, {
      method: 'POST',
    })
  }

  async rejectPendingBatch(batchId: string) {
    return this.request<{ rejected: number; errors: string[] }>(`/pending-approval/batch/${batchId}/reject`, {
      method: 'POST',
    })
  }
}

export const api = new ApiClient()
