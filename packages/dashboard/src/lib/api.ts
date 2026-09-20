import type { ConnectionInfo } from "../../../proxy/src/lib/codex-types"

export type { ConnectionInfo } from "../../../proxy/src/lib/codex-types"

const PROXY_URL = import.meta.env.VITE_PROXY_URL || ""
const API_KEY = import.meta.env.VITE_API_KEY || ""

async function fetchApi(path: string, options?: RequestInit) {
  const authHeaders: Record<string, string> = API_KEY
    ? { Authorization: `Bearer ${API_KEY}` }
    : {}
  const res = await fetch(`${PROXY_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders, ...options?.headers },
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export const api = {
  getStats: () => fetchApi("/api/stats"),
  getRequests: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (params?.limit) q.set("limit", String(params.limit))
    if (params?.offset) q.set("offset", String(params.offset))
    return fetchApi(`/api/requests?${q}`)
  },
  getModels: () => fetchApi("/api/copilot/models"),
  getConnectionInfo: (): Promise<ConnectionInfo> => fetchApi("/api/connection-info"),
  getSettings: () => fetchApi("/api/settings"),
  getKeys: () => fetchApi("/api/keys"),
  getUpstreams: () => fetchApi("/api/upstreams"),
  getHealth: () => fetchApi("/health"),
  createKey: (name: string) => fetchApi("/api/keys", { method: "POST", body: JSON.stringify({ name }) }),
  revokeKey: (id: string) => fetchApi(`/api/keys/${id}`, { method: "DELETE" }),
  createUpstream: (data: any) => fetchApi("/api/upstreams", { method: "POST", body: JSON.stringify(data) }),
  deleteUpstream: (id: number) => fetchApi(`/api/upstreams/${id}`, { method: "DELETE" }),
}
