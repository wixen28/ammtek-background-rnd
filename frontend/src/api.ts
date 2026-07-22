const API_BASE_URL = 'http://localhost:8000'

export interface VideoRecord {
  video_id: string
  filename: string
  width: number
  height: number
  fps: number
  frame_count: number
  duration_seconds: number
}

export async function checkHealth(): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/api/health`)
  return res.ok
}

async function errorDetail(res: Response): Promise<string> {
  const detail = await res
    .json()
    .then((body) => (typeof body.detail === 'string' ? body.detail : null))
    .catch(() => null)
  return detail ?? `Request failed with status ${res.status}`
}

export async function uploadVideo(file: File): Promise<VideoRecord> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${API_BASE_URL}/api/videos`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) throw new Error(await errorDetail(res))
  return res.json()
}

export interface RgbMeanParams {
  target_frames: number
  resize: [number, number] | null
}

export interface RgbMeanResult {
  target_frames: number
  every_n: number
  sampled_frames: number
  resize: [number, number] | null
  processing_time_seconds: number
  background: string
  previews: string[]
}

export async function runRgbMean(params: RgbMeanParams): Promise<RgbMeanResult> {
  const res = await fetch(`${API_BASE_URL}/api/experiments/rgb-mean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) throw new Error(await errorDetail(res))
  return res.json()
}

export interface PixelSample {
  frame_index: number
  timestamp_seconds: number
  r: number
  g: number
  b: number
}

export interface PixelTimeline {
  x: number
  y: number
  frame_count: number
  frames: PixelSample[]
}

export async function getPixelTimeline(
  x: number,
  y: number,
): Promise<PixelTimeline> {
  const res = await fetch(
    `${API_BASE_URL}/api/experiments/pixel-timeline?x=${x}&y=${y}`,
  )
  if (!res.ok) throw new Error(await errorDetail(res))
  return res.json()
}

export async function getCurrentVideo(): Promise<VideoRecord | null> {
  const res = await fetch(`${API_BASE_URL}/api/videos/current`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await errorDetail(res))
  return res.json()
}
