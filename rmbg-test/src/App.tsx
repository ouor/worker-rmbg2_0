import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type ImageSource = 'url' | 'upload'

type ErrorInfo = {
  code: string
  message: string
  detail?: string
}

type ApiResponse = {
  id?: string
  status?: string
  delayTime?: number
  executionTime?: number
  workerId?: string
  output?: {
    image?: string
    errorInfo?: ErrorInfo
  }
  // populated locally when fetch itself fails (network / CORS / non-JSON)
  __localError?: string
  __httpStatus?: number
}

const DEFAULT_ENDPOINT = 'https://api.runpod.ai/v2/7obvawirnddq43/runsync'
const DEFAULT_IMAGE_URL =
  'https://images.unsplash.com/photo-1517849845537-4d257902454a?w=800'

const LS_ENDPOINT = 'rmbg.endpoint'
const LS_API_KEY = 'rmbg.apiKey'

function shellEscapeSingleQuoted(s: string): string {
  // Wrap in single quotes; escape embedded single quotes as '\''
  return `'${s.replace(/'/g, "'\\''")}'`
}

function abbreviateForDisplay(s: string, max = 96): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…<${s.length.toLocaleString()} chars total>`
}

function App() {
  const [endpoint, setEndpoint] = useState(
    () => localStorage.getItem(LS_ENDPOINT) ?? DEFAULT_ENDPOINT,
  )
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(LS_API_KEY) ?? '',
  )
  const [imageSource, setImageSource] = useState<ImageSource>('url')
  const [imageUrl, setImageUrl] = useState(DEFAULT_IMAGE_URL)
  const [uploadName, setUploadName] = useState('')
  const [uploadDataUri, setUploadDataUri] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ApiResponse | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Persist endpoint and key
  useEffect(() => {
    localStorage.setItem(LS_ENDPOINT, endpoint)
  }, [endpoint])
  useEffect(() => {
    localStorage.setItem(LS_API_KEY, apiKey)
  }, [apiKey])

  // Live elapsed counter while a request is in flight
  useEffect(() => {
    if (!loading) return
    const start = performance.now()
    setElapsed(0)
    const id = window.setInterval(
      () => setElapsed(performance.now() - start),
      50,
    )
    return () => window.clearInterval(id)
  }, [loading])

  const selectedImage = imageSource === 'url' ? imageUrl : uploadDataUri
  const hasImage = selectedImage.length > 0

  // ------------------------------------------------------------------
  // Live curl preview (display abbreviates long base64 bodies; copy uses full body)
  // ------------------------------------------------------------------
  const buildCurl = (imgValue: string): string => {
    const body = JSON.stringify({ input: { image: imgValue } })
    const key = apiKey || '<RUNPOD_API_KEY>'
    return [
      `curl -X POST ${shellEscapeSingleQuoted(endpoint)} \\`,
      `  -H 'Authorization: Bearer ${key}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d ${shellEscapeSingleQuoted(body)}`,
    ].join('\n')
  }

  const curlForDisplay = useMemo(() => {
    const imgValue =
      imageSource === 'url'
        ? imageUrl || '<image url>'
        : uploadDataUri
          ? abbreviateForDisplay(uploadDataUri)
          : '<no file selected>'
    return buildCurl(imgValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, apiKey, imageSource, imageUrl, uploadDataUri])

  const curlForCopy = useMemo(() => {
    const imgValue = imageSource === 'url' ? imageUrl : uploadDataUri
    return buildCurl(imgValue || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, apiKey, imageSource, imageUrl, uploadDataUri])

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curlForCopy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable in some contexts */
    }
  }

  // ------------------------------------------------------------------
  // File handling
  // ------------------------------------------------------------------
  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('이미지 파일만 업로드할 수 있습니다.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setUploadName(`${file.name} (${(file.size / 1024).toFixed(1)} KB)`)
      setUploadDataUri(reader.result as string)
    }
    reader.onerror = () => alert('파일을 읽을 수 없습니다.')
    reader.readAsDataURL(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  // ------------------------------------------------------------------
  // API call
  // ------------------------------------------------------------------
  const onGo = async () => {
    if (!apiKey.trim()) {
      alert('API Key를 입력해주세요.')
      return
    }
    if (!hasImage) {
      alert('이미지 URL을 입력하거나 파일을 업로드해주세요.')
      return
    }

    setLoading(true)
    setResult(null)
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: { image: selectedImage } }),
      })
      let body: ApiResponse
      try {
        body = (await resp.json()) as ApiResponse
      } catch {
        body = {
          __localError: `Non-JSON response (HTTP ${resp.status})`,
          __httpStatus: resp.status,
        }
      }
      if (!resp.ok && !body.__localError) {
        body.__httpStatus = resp.status
      }
      setResult(body)
    } catch (err) {
      setResult({
        __localError:
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    } finally {
      setLoading(false)
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const errorInfo = result?.output?.errorInfo
  const outputImage = result?.output?.image
  const localError = result?.__localError
  const previewSource =
    imageSource === 'url' ? imageUrl : uploadDataUri || ''

  return (
    <div className="app">
      <header className="hdr">
        <h1>RMBG-2.0 API Tester</h1>
        <p className="sub">
          Send an image to the RunPod serverless endpoint and inspect the
          background-removed result.
        </p>
      </header>

      <section className="panel">
        <h2>Connection</h2>
        <label className="field">
          <span>Endpoint URL</span>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.runpod.ai/v2/<endpoint-id>/runsync"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="rpa_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </section>

      <section className="panel">
        <h2>Image</h2>
        <div className="tabs">
          <button
            className={imageSource === 'url' ? 'tab active' : 'tab'}
            onClick={() => setImageSource('url')}
            type="button"
          >
            URL
          </button>
          <button
            className={imageSource === 'upload' ? 'tab active' : 'tab'}
            onClick={() => setImageSource('upload')}
            type="button"
          >
            Upload
          </button>
        </div>

        {imageSource === 'url' ? (
          <label className="field">
            <span>Image URL</span>
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://example.com/photo.jpg"
              spellCheck={false}
            />
          </label>
        ) : (
          <div
            className={`dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInputRef.current?.click()
              }
            }}
          >
            {uploadName ? (
              <div className="dz-info">
                <strong>{uploadName}</strong>
                <span className="muted">
                  click or drop another file to replace
                </span>
              </div>
            ) : (
              <div className="dz-info">
                <strong>Click to choose a file</strong>
                <span className="muted">or drag-and-drop here</span>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
            />
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Live curl preview</h2>
          <button className="copy" onClick={copyCurl} type="button">
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <pre className="curl">
          <code>{curlForDisplay}</code>
        </pre>
        {imageSource === 'upload' && uploadDataUri && (
          <p className="hint">
            Body is abbreviated for display. Copy uses the full base64 (~
            {uploadDataUri.length.toLocaleString()} chars).
          </p>
        )}
      </section>

      <section className="panel actions">
        <button
          className="go"
          onClick={onGo}
          type="button"
          disabled={loading || !hasImage || !apiKey}
        >
          {loading ? `Running… ${(elapsed / 1000).toFixed(1)}s` : 'Go'}
        </button>
        {!apiKey && <span className="muted">API Key를 먼저 입력하세요.</span>}
      </section>

      {result && (
        <section className="panel">
          <h2>Result</h2>

          {localError && (
            <div className="error-box">
              <strong>
                Local / network error
                {result.__httpStatus ? ` (HTTP ${result.__httpStatus})` : ''}
              </strong>
              <pre>{localError}</pre>
              <p className="hint">
                CORS, 잘못된 URL, 네트워크 단절, 또는 RunPod 플랫폼 4xx/5xx 응답일
                수 있습니다.
              </p>
            </div>
          )}

          {!localError && (
            <div className="meta">
              <Meta label="status" value={result.status} />
              <Meta
                label="delayTime"
                value={
                  result.delayTime != null ? `${result.delayTime} ms` : undefined
                }
              />
              <Meta
                label="executionTime"
                value={
                  result.executionTime != null
                    ? `${result.executionTime} ms`
                    : undefined
                }
              />
              <Meta label="workerId" value={result.workerId} mono />
              <Meta label="id" value={result.id} mono />
            </div>
          )}

          {errorInfo && (
            <div className="error-box">
              <strong>errorInfo.code: {errorInfo.code}</strong>
              <p>{errorInfo.message}</p>
              {errorInfo.detail && <pre>{errorInfo.detail}</pre>}
            </div>
          )}

          {(previewSource || outputImage) && (
            <div className="compare">
              <figure>
                <figcaption>Input</figcaption>
                {previewSource ? (
                  <img src={previewSource} alt="input" />
                ) : (
                  <div className="placeholder">no image</div>
                )}
              </figure>
              <figure>
                <figcaption>Output (RGBA on checker)</figcaption>
                {outputImage ? (
                  <div className="checker">
                    <img src={outputImage} alt="output" />
                  </div>
                ) : (
                  <div className="placeholder">no output</div>
                )}
              </figure>
            </div>
          )}

          <details className="raw">
            <summary>Raw response JSON</summary>
            <pre>
              {JSON.stringify(
                {
                  ...result,
                  output: result.output
                    ? {
                        ...result.output,
                        image: outputImage
                          ? `${outputImage.slice(0, 64)}…<${outputImage.length.toLocaleString()} chars>`
                          : undefined,
                      }
                    : undefined,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </section>
      )}

      <footer className="ftr">
        Endpoint &amp; API key are persisted to localStorage for this browser
        only.
      </footer>
    </div>
  )
}

function Meta(props: {
  label: string
  value?: string | number
  mono?: boolean
}) {
  if (props.value === undefined || props.value === null || props.value === '')
    return null
  return (
    <div className="meta-cell">
      <span className="meta-label">{props.label}</span>
      <span className={`meta-value${props.mono ? ' mono' : ''}`}>
        {String(props.value)}
      </span>
    </div>
  )
}

export default App
