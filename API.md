# RMBG-2.0 Background Remover API

BRIA RMBG-2.0 모델을 사용해 이미지의 배경을 제거하는 서버리스 API입니다. 이미지 1장을 받아 알파 채널이 적용된 RGBA PNG 1장을 반환합니다.

- **Base URL**: `https://api.runpod.ai/v2/{ENDPOINT_ID}`
- **Endpoint ID**: `7obvawirnddq43`
- **Protocol**: HTTPS, JSON
- **Auth**: `Authorization: Bearer <RUNPOD_API_KEY>`

---

## 목차
- [인증](#인증)
- [공통 응답 구조](#공통-응답-구조)
- [엔드포인트](#엔드포인트)
  - [POST `/runsync` — 동기 실행](#post-runsync--동기-실행)
  - [POST `/run` — 비동기 실행](#post-run--비동기-실행)
  - [GET `/status/{id}` — 작업 상태 조회](#get-statusid--작업-상태-조회)
  - [POST `/cancel/{id}` — 작업 취소](#post-cancelid--작업-취소)
  - [GET `/health` — 엔드포인트 헬스체크](#get-health--엔드포인트-헬스체크)
- [입력 스펙](#입력-스펙)
- [출력 스펙](#출력-스펙)
- [에러 코드](#에러-코드)
- [입력 한도](#입력-한도)
- [예시](#예시)
- [성능 / 콜드스타트](#성능--콜드스타트)

---

## 인증

모든 요청은 RunPod API 키를 Bearer 토큰으로 전달해야 합니다.

```http
Authorization: Bearer rpa_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

API 키는 [RunPod 콘솔 → User Settings](https://www.runpod.io/console/user/settings)에서 발급합니다.

---

## 공통 응답 구조

모든 작업 응답은 다음 골격을 따릅니다.

```jsonc
{
  "id": "sync-9c0ff108-…",     // 작업 ID
  "status": "COMPLETED",        // IN_QUEUE | IN_PROGRESS | COMPLETED | FAILED | CANCELLED | TIMED_OUT
  "delayTime": 4014,            // 큐 대기 + 워커 콜드스타트 (ms)
  "executionTime": 270,         // 실제 핸들러 실행 시간 (ms)
  "workerId": "q42pq3167it6fc", // 작업을 처리한 워커
  "output": {                   // 성공 또는 핸들러 에러 페이로드
    "image": "data:image/png;base64,…"
    // 또는 "errorInfo": { "code": "...", "message": "...", "detail": "..." }
  }
}
```

> **`output.errorInfo` 키 이름**: 핸들러가 검증·다운로드·디코딩 실패를 알릴 때 사용하는 키입니다. RunPod SDK가 top-level `error` 키를 가로채 클라이언트 응답에서 빠뜨리기 때문에 의도적으로 다른 이름을 사용합니다.

---

## 엔드포인트

### POST `/runsync` — 동기 실행
요청을 보낸 뒤 처리가 끝날 때까지 동기로 기다립니다. **최대 30초** 안에 끝나지 않으면 자동으로 비동기로 전환되어 `IN_PROGRESS`/`IN_QUEUE` 상태와 작업 ID를 즉시 반환합니다.

**요청**
```http
POST /v2/{ENDPOINT_ID}/runsync HTTP/1.1
Host: api.runpod.ai
Authorization: Bearer rpa_xxx
Content-Type: application/json

{ "input": { "image": "<data URI | URL | raw base64>" } }
```

**응답 (200, 성공)**
```jsonc
{
  "id": "sync-…",
  "status": "COMPLETED",
  "delayTime": 4014,
  "executionTime": 270,
  "output": { "image": "data:image/png;base64,iVBOR…" }
}
```

**응답 (200, 핸들러 에러)**
```jsonc
{
  "id": "sync-…",
  "status": "COMPLETED",
  "output": {
    "errorInfo": {
      "code": "image_fetch_failed",
      "message": "URL returned HTTP 404.",
      "detail": "NOT FOUND"
    }
  }
}
```

> 핸들러가 검증한 에러는 HTTP 200이며, `output.errorInfo`로 구분합니다. HTTP 4xx/5xx는 RunPod 플랫폼 차원의 오류 (인증 실패, 엔드포인트 미존재 등) 입니다.

---

### POST `/run` — 비동기 실행
요청을 큐에 적재하고 즉시 작업 ID를 반환합니다. 결과는 [`/status/{id}`](#get-statusid--작업-상태-조회)로 폴링하거나 webhook으로 받습니다.

**요청 본문 (선택 필드 포함)**
```jsonc
{
  "input": { "image": "<…>" },
  "webhook": "https://my-server.example.com/runpod-callback",  // 선택
  "executionTimeout": 60000,                                    // 선택, 기본 600000
  "policy": { "ttl": 3600000 }                                  // 선택
}
```

**응답 (200)**
```json
{ "id": "abcd-1234-…", "status": "IN_QUEUE" }
```

**`status` 전이**: `IN_QUEUE → IN_PROGRESS → COMPLETED` (또는 `FAILED`, `CANCELLED`, `TIMED_OUT`).

---

### GET `/status/{id}` — 작업 상태 조회

```http
GET /v2/{ENDPOINT_ID}/status/{JOB_ID}
Authorization: Bearer rpa_xxx
```

응답 구조는 [`/runsync`](#post-runsync--동기-실행)와 동일하며, 작업이 끝나지 않은 경우 `output`이 비어 있습니다.

---

### POST `/cancel/{id}` — 작업 취소

큐에 있거나 실행 중인 작업을 취소합니다.

```http
POST /v2/{ENDPOINT_ID}/cancel/{JOB_ID}
Authorization: Bearer rpa_xxx
```

응답:
```json
{ "id": "abcd-…", "status": "CANCELLED" }
```

---

### GET `/health` — 엔드포인트 헬스체크

워커 풀 상태와 누적 작업 통계를 반환합니다.

```http
GET /v2/{ENDPOINT_ID}/health
Authorization: Bearer rpa_xxx
```

**응답**
```json
{
  "jobs": {
    "completed": 9,
    "failed": 3,
    "inProgress": 0,
    "inQueue": 0,
    "retried": 3
  },
  "workers": {
    "ready": 1,
    "idle": 1,
    "initializing": 1,
    "running": 0,
    "throttled": 1,
    "unhealthy": 0
  }
}
```

---

## 입력 스펙

요청 본문은 다음 한 형태입니다.

```jsonc
{
  "input": {
    "image": "<string, required>"
  }
}
```

`image`는 다음 세 가지 형식 중 하나로 자동 인식됩니다.

| 형식 | 예시 |
|------|------|
| **data URI (base64)** | `data:image/png;base64,iVBORw0KGgo...` |
| **http(s) URL** | `https://example.com/photo.jpg` |
| **raw base64** (prefix 없음) | `iVBORw0KGgo...` |

지원 이미지 포맷: PNG / JPEG / WebP / BMP / TIFF / GIF (Pillow가 디코딩할 수 있는 모든 형식).
모델 입력은 내부적으로 1024×1024로 리사이즈됩니다 (출력은 원본 해상도로 복원).

---

## 출력 스펙

성공 시 `output.image`는 단일 문자열입니다.

```
data:image/png;base64,iVBORw0KGgo...
```

| 항목 | 값 |
|------|-----|
| MIME | `image/png` |
| 색공간 | **RGBA** (RGB + 예측된 알파 매트) |
| 해상도 | **입력과 동일** |
| 인코딩 | base64 (data URI prefix 포함) |

### 클라이언트 디코딩 예시 (Python)
```python
header, payload = result["output"]["image"].split(",", 1)
png_bytes = base64.b64decode(payload)
with open("no_bg.png", "wb") as f:
    f.write(png_bytes)
```

---

## 에러 코드

`output.errorInfo` 안에 들어오는 코드는 다음과 같습니다.

| `code` | HTTP equiv | 의미 | 발생 트리거 |
|--------|-----------|------|------------|
| `invalid_input` | 400 | 입력 페이로드가 잘못됨 | `input`이 객체 아님 / `image` 누락 / 빈 문자열 / 문자열 아님 / base64 문법 오류 / 비-image data URI |
| `image_fetch_failed` | 502 | URL에서 이미지를 가져올 수 없음 | DNS 실패 / 연결 거부 / 타임아웃(30s) / HTTP 4xx·5xx / 스트림 read 오류 |
| `image_decode_failed` | 400 | 받은 바이트를 이미지로 해석할 수 없음 | 이미지가 아닌 바이트 / 손상된 이미지 / Decompression bomb |
| `image_too_large` | 413 | 입력이 크기 한도를 초과 | 다운로드 > 25 MB / 디코딩 후 > 50 MB / 픽셀 > 50 MP |
| `inference_failed` | 500 | 모델 추론 실패 | GPU OOM / torch RuntimeError |
| `internal_error` | 500 | 그 외 예상치 못한 서버 오류 | 위 분류에 해당하지 않는 모든 예외 |

### `errorInfo` 객체 구조
```jsonc
{
  "code": "image_fetch_failed",                  // 위 표 참고
  "message": "URL returned HTTP 404.",           // 사람이 읽기 위한 메시지
  "detail": "NOT FOUND"                          // 선택: 디버깅용 추가 정보
}
```

---

## 입력 한도

| 항목 | 한도 |
|------|------|
| URL 다운로드 크기 | **25 MB** |
| base64 디코딩 후 크기 | **50 MB** |
| 이미지 픽셀 수 | **50 MP** (예: 7071×7071) |
| URL fetch 타임아웃 | **30초** |
| 동기(`/runsync`) 응답 대기 | RunPod 기본 30초, 초과 시 자동 비동기 전환 |
| 비동기 작업 실행 타임아웃 | 기본 10분, `executionTimeout`으로 조절 |

---

## 예시

### cURL — URL 입력
```bash
curl -X POST "https://api.runpod.ai/v2/7obvawirnddq43/runsync" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "image": "https://images.unsplash.com/photo-1517849845537-4d257902454a?w=800"
    }
  }'
```

### cURL — base64 입력
```bash
B64=$(base64 -w0 photo.jpg)
curl -X POST "https://api.runpod.ai/v2/7obvawirnddq43/runsync" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"input\":{\"image\":\"data:image/jpeg;base64,${B64}\"}}"
```

### Python (requests, 동기)
```python
import base64
import requests

API_KEY = "rpa_..."
ENDPOINT = "7obvawirnddq43"

def remove_bg(image_path: str, out_path: str) -> None:
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    resp = requests.post(
        f"https://api.runpod.ai/v2/{ENDPOINT}/runsync",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"input": {"image": f"data:image/jpeg;base64,{b64}"}},
        timeout=120,
    )
    resp.raise_for_status()
    body = resp.json()

    out = body.get("output") or {}
    if "errorInfo" in out:
        raise RuntimeError(f"{out['errorInfo']['code']}: {out['errorInfo']['message']}")

    _, payload = out["image"].split(",", 1)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(payload))


remove_bg("photo.jpg", "no_bg.png")
```

### Python (비동기 + 폴링)
```python
import time, requests

job = requests.post(
    f"https://api.runpod.ai/v2/{ENDPOINT}/run",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"input": {"image": "https://example.com/photo.jpg"}},
).json()
job_id = job["id"]

while True:
    s = requests.get(
        f"https://api.runpod.ai/v2/{ENDPOINT}/status/{job_id}",
        headers={"Authorization": f"Bearer {API_KEY}"},
    ).json()
    if s["status"] in {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}:
        print(s)
        break
    time.sleep(2)
```

### Node.js (fetch)
```js
const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT = "7obvawirnddq43";

async function removeBg(imageUrl) {
  const r = await fetch(`https://api.runpod.ai/v2/${ENDPOINT}/runsync`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: { image: imageUrl } }),
  });
  const body = await r.json();
  const out = body.output ?? {};
  if (out.errorInfo) {
    throw new Error(`${out.errorInfo.code}: ${out.errorInfo.message}`);
  }
  return out.image; // data:image/png;base64,...
}
```

### 에러 응답 받기 (확인 필수)
```python
out = response.json().get("output") or {}
if "errorInfo" in out:
    info = out["errorInfo"]
    if info["code"] == "image_too_large":
        # 사용자에게 더 작은 이미지 안내
        ...
    elif info["code"] == "image_fetch_failed":
        # URL 재확인 / 재시도
        ...
    else:
        # 그 외 에러
        ...
else:
    image_data_uri = out["image"]
```

---

## 성능 / 콜드스타트

| 시나리오 | `delayTime` | `executionTime` |
|----------|-------------|-----------------|
| **Warm worker, 작은 이미지(~32px)** | <1 s | ~50 ms |
| **Warm worker, 일반 이미지(800px~)** | <1 s | **200–400 ms** |
| **Cold worker** (전체 이미지 풀 + 모델 로드) | 10–30 s | 200–400 ms |

- 이미지 가중치는 컨테이너에 baked-in 되어 있어 외부 다운로드 없이 부팅합니다.
- `idleTimeout`이 5분이라 그 안에 후속 요청이 오면 콜드스타트가 발생하지 않습니다.
- 처음 요청 시 워커가 `initializing`이면 `delayTime`이 길어집니다.

---

## 라이선스 안내

본 워커가 사용하는 BRIA RMBG-2.0 모델은 **CC BY-NC 4.0** (비상업적 사용 한정) 라이선스입니다. 상업 용도로 이 API를 사용하려면 [BRIA AI](https://bria.ai)와 별도 라이선스 계약이 필요합니다.
