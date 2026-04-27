# worker-rmbg20

[BRIA RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) 배경 제거 모델을 RunPod Serverless에서 구동하는 워커입니다.

- **모델**: BRIA RMBG-2.0 (BiRefNet 기반, 0.2B 파라미터)
- **추론**: CUDA + FP16
- **입력**: 이미지 1장 (data URI / http(s) URL / raw base64)
- **출력**: 배경이 제거된 RGBA PNG 1장 (base64 data URI)

---

## 요청 / 응답

### 입력 스키마

```jsonc
{
  "input": {
    "image": "<string, required>"
  }
}
```

`image` 필드 하나만 받으며, 다음 세 가지 형식을 자동 인식합니다:

| 형식 | 예시 |
|------|------|
| **data URI (base64)** | `data:image/png;base64,iVBORw0KGgo...` |
| **http(s) URL** | `https://example.com/photo.jpg` |
| **raw base64** (prefix 없음) | `iVBORw0KGgo...` |

### 성공 응답

```jsonc
{
  "image": "data:image/png;base64,iVBORw0KGgo..."
}
```

- 항상 **PNG** 형식 (알파 채널 보존을 위해)
- 모드: **RGBA** — 알파 채널이 RMBG-2.0이 예측한 매트
- 해상도: **입력 원본과 동일** (모델은 1024×1024로 내부 처리 후 원본 크기로 복원)

### 에러 응답

```jsonc
{
  "error": {
    "code": "<string>",
    "message": "<human-readable>",
    "detail": "<optional, technical>"
  }
}
```

---

## 에러 코드

| `code` | HTTP | 의미 | 발생 트리거 |
|--------|------|------|------------|
| `invalid_input` | 400 | 입력 페이로드가 잘못됨 | `input`이 객체 아님 / `image` 누락 / 빈 문자열 / 문자열 아님 / base64 문법 오류 / 비-image data URI |
| `image_fetch_failed` | 502 | URL에서 이미지를 가져올 수 없음 | DNS 실패 / 연결 거부 / 타임아웃(30s) / HTTP 4xx·5xx / 스트림 read 오류 |
| `image_decode_failed` | 400 | 받은 바이트를 이미지로 해석할 수 없음 | 이미지가 아닌 바이트 / 손상된 이미지 / Decompression bomb |
| `image_too_large` | 413 | 입력이 크기 한도를 초과 | 다운로드 > 25 MB / 디코딩 후 > 50 MB / 픽셀 > 50 MP |
| `inference_failed` | 500 | 모델 추론 실패 | GPU OOM / torch RuntimeError |
| `internal_error` | 500 | 그 외 예상치 못한 서버 오류 | 위 분류에 해당하지 않는 모든 예외 |

### 입력 한도

| 항목 | 한도 | 환경값 |
|------|------|--------|
| URL 다운로드 크기 | 25 MB | `MAX_FETCH_BYTES` |
| base64 디코딩 후 크기 | 50 MB | `MAX_DECODED_BYTES` |
| 이미지 픽셀 수 | 50 MP (예: 7071×7071) | `MAX_IMAGE_PIXELS` |
| URL fetch 타임아웃 | 30 초 | `FETCH_TIMEOUT` |

---

## 사용 예시

### URL 입력
```bash
curl -X POST https://api.runpod.ai/v2/<endpoint-id>/runsync \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "image": "https://images.unsplash.com/photo-1517849845537-4d257902454a?w=800"
    }
  }'
```

### Base64 입력 (Python)
```python
import base64, requests

with open("photo.jpg", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

resp = requests.post(
    "https://api.runpod.ai/v2/<endpoint-id>/runsync",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"input": {"image": f"data:image/jpeg;base64,{b64}"}},
)
result = resp.json()["output"]

# 결과 PNG 저장
header, payload = result["image"].split(",", 1)
with open("no_bg.png", "wb") as f:
    f.write(base64.b64decode(payload))
```

### 에러 응답 예시
```json
{
  "output": {
    "error": {
      "code": "image_too_large",
      "message": "Downloaded image exceeds 25 MB."
    }
  }
}
```

```json
{
  "output": {
    "error": {
      "code": "image_fetch_failed",
      "message": "URL returned HTTP 404.",
      "detail": "NOT FOUND"
    }
  }
}
```

---

## 로컬 개발

### 의존성 설치
```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Linux/macOS
pip install -r requirements.txt
```

### 핸들러 직접 실행
```bash
python handler.py --test_input "$(cat test_input.json)"
```

처음 실행 시 `briaai/RMBG-2.0`에서 `model.safetensors` + 설정 파일들(약 844 MB)을 HuggingFace 캐시로 다운로드합니다. ONNX(~3 GB)와 `pytorch_model.bin`(885 MB)은 받지 않습니다.

### Docker 빌드

`briaai/RMBG-2.0`은 **gated repository**이므로 빌드 시 HuggingFace 토큰이 필요합니다. 토큰은 BuildKit secret으로 전달되어 이미지 레이어에 남지 않습니다 (런타임에는 모델이 이미 포함되어 있으므로 토큰이 필요 없습니다).

```bash
# HF 토큰을 환경변수로 등록 (https://huggingface.co/settings/tokens)
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Build (BuildKit secret으로 토큰 전달)
docker build --secret id=hf_token,env=HF_TOKEN -t worker-rmbg20 .

# Run
docker run --rm --gpus all worker-rmbg20
```

빌드 시 모델 가중치가 이미지에 포함되므로 런타임에 추가 다운로드 없이 오프라인(`--network none`)에서도 동작합니다.

### GitHub Actions 자동 배포

`.github/workflows/docker-publish.yml`이 다음 조건에서 Docker Hub로 자동 빌드/푸시합니다:

| 트리거 | 적용 태그 |
|--------|-----------|
| `main` 브랜치에 push | `:latest`, `:v1.0`, `:main-<short-sha>` |
| `v*` 형태 git tag push (예: `v1.1`) | `:latest`, `:<tag>` |
| 수동 실행 (Actions 탭 → Run workflow) | `:latest`, 입력한 버전 태그 |

#### 필요한 GitHub Secrets
저장소 Settings → Secrets and variables → Actions에서 등록:

| 이름 | 값 |
|------|-----|
| `DOCKERHUB_USERNAME` | Docker Hub 사용자명 |
| `DOCKERHUB_TOKEN` | Docker Hub PAT ([생성](https://hub.docker.com/settings/security)) |
| `HF_TOKEN` | HuggingFace 액세스 토큰 (gated repo 다운로드용) |

`gh` CLI 사용 시:
```bash
gh secret set DOCKERHUB_USERNAME --body "<username>"
gh secret set DOCKERHUB_TOKEN --body "<dckr_pat_...>"
gh secret set HF_TOKEN --body "$HF_TOKEN"
```

---

## 아키텍처 메모

- **모델 로드**: 콜드스타트 시 1회만 (`AutoModelForImageSegmentation.from_pretrained` + `local_files_only=True`)
- **정밀도**: GPU에서는 FP16, CPU 폴백 시 FP32
- **전처리**: 1024×1024 리사이즈 → ImageNet 정규화 → 텐서
- **후처리**: sigmoid 마스크를 원본 해상도로 BILINEAR 업샘플 → `putalpha`로 RGBA 생성
- **모델 파일 다운로드 패턴**: `["*.json", "*.py", "model.safetensors"]` — ONNX 폴더와 `.bin`은 명시적으로 제외

---

## 라이선스

본 워커 코드: MIT
모델 가중치 (BRIA RMBG-2.0): **CC BY-NC 4.0** (비상업적 사용 한정). 상업 용도는 [BRIA AI](https://bria.ai)와 별도 라이선스 계약이 필요합니다.
