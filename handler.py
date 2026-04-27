"""RunPod Serverless handler for BRIA RMBG-2.0 background removal."""

import base64
import binascii
import io
import logging
import re

import requests
import runpod
import torch
from huggingface_hub import snapshot_download
from PIL import Image, UnidentifiedImageError
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("rmbg20")


# ---------------------------------------------------------------------------
# Domain exceptions
# ---------------------------------------------------------------------------
class WorkerError(Exception):
    """Base class for handler errors. Maps to a structured response."""

    code = "internal_error"
    http_status = 500

    def __init__(self, message: str, *, detail: str | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail

    def to_dict(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.detail:
            out["detail"] = self.detail
        return out


class InvalidInputError(WorkerError):
    """The `input` payload is missing required fields or has the wrong shape."""

    code = "invalid_input"
    http_status = 400


class ImageFetchError(WorkerError):
    """A URL was provided but could not be fetched (network / HTTP / size)."""

    code = "image_fetch_failed"
    http_status = 502


class ImageDecodeError(WorkerError):
    """Bytes were obtained but couldn't be decoded as a valid image."""

    code = "image_decode_failed"
    http_status = 400


class ImageTooLargeError(WorkerError):
    """Image bytes or pixel dimensions exceed configured limits."""

    code = "image_too_large"
    http_status = 413


class InferenceError(WorkerError):
    """Model forward pass failed (CUDA OOM, runtime error, etc.)."""

    code = "inference_failed"
    http_status = 500


# ---------------------------------------------------------------------------
# Limits (defensive — abuse / OOM protection)
# ---------------------------------------------------------------------------
MAX_FETCH_BYTES = 25 * 1024 * 1024     # 25 MB download cap for URL inputs
MAX_DECODED_BYTES = 50 * 1024 * 1024   # 50 MB raw bytes cap (covers base64 too)
MAX_IMAGE_PIXELS = 50_000_000          # 50 MP — putalpha at orig resolution
FETCH_TIMEOUT = 30                     # seconds


# ---------------------------------------------------------------------------
# Model load (cold start)
# ---------------------------------------------------------------------------
MODEL_ID = "briaai/RMBG-2.0"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

# Only fetch what we actually need — skip the duplicate `pytorch_model.bin`
# (885 MB) and the entire `onnx/` directory (~3 GB across 8 quantizations).
# In the Docker image these files are already pre-cached at build time, so
# this call is effectively a no-op there; locally it acts as a guard.
_ALLOW_PATTERNS = ["*.json", "*.py", "model.safetensors"]

logger.info("Ensuring model files cached: %s", _ALLOW_PATTERNS)
_local_dir = snapshot_download(repo_id=MODEL_ID, allow_patterns=_ALLOW_PATTERNS)

logger.info("Loading %s on %s (%s)", MODEL_ID, DEVICE, DTYPE)
torch.set_grad_enabled(False)

model = AutoModelForImageSegmentation.from_pretrained(
    _local_dir,
    trust_remote_code=True,
    local_files_only=True,
)
model.to(DEVICE)
if DTYPE == torch.float16:
    model.half()
model.eval()

try:
    torch.set_float32_matmul_precision("high")
except Exception:  # pragma: no cover - older torch
    pass

logger.info("Model ready")

IMAGE_SIZE = (1024, 1024)
_transform = transforms.Compose(
    [
        transforms.Resize(IMAGE_SIZE),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ]
)

_DATA_URI_RE = re.compile(r"^data:image/[\w.+-]+;base64,(.+)$", re.DOTALL)


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------
def _fetch_url(url: str) -> bytes:
    try:
        resp = requests.get(url, timeout=FETCH_TIMEOUT, stream=True)
    except requests.Timeout as exc:
        raise ImageFetchError("URL fetch timed out.", detail=str(exc)) from exc
    except requests.ConnectionError as exc:
        raise ImageFetchError("Could not connect to URL.", detail=str(exc)) from exc
    except requests.RequestException as exc:
        raise ImageFetchError("URL fetch failed.", detail=str(exc)) from exc

    with resp:
        if resp.status_code >= 400:
            raise ImageFetchError(
                f"URL returned HTTP {resp.status_code}.",
                detail=resp.reason,
            )

        # Stream-read with size cap to prevent memory blow-up.
        buf = bytearray()
        try:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                buf.extend(chunk)
                if len(buf) > MAX_FETCH_BYTES:
                    raise ImageTooLargeError(
                        f"Downloaded image exceeds {MAX_FETCH_BYTES // (1024 * 1024)} MB."
                    )
        except requests.RequestException as exc:
            raise ImageFetchError("URL stream read failed.", detail=str(exc)) from exc
    return bytes(buf)


def _decode_base64(b64_text: str) -> bytes:
    try:
        raw = base64.b64decode(b64_text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidInputError(
            "'image' is not valid base64.", detail=str(exc)
        ) from exc
    if len(raw) > MAX_DECODED_BYTES:
        raise ImageTooLargeError(
            f"Decoded image exceeds {MAX_DECODED_BYTES // (1024 * 1024)} MB."
        )
    return raw


def _decode_image(raw: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()  # force decode now so truncation surfaces here
    except UnidentifiedImageError as exc:
        raise ImageDecodeError("Bytes are not a recognized image format.") from exc
    except (OSError, Image.DecompressionBombError) as exc:
        raise ImageDecodeError("Image is corrupt or unsafe to decode.", detail=str(exc)) from exc

    w, h = img.size
    if w * h > MAX_IMAGE_PIXELS:
        raise ImageTooLargeError(
            f"Image resolution {w}x{h} exceeds {MAX_IMAGE_PIXELS:,} pixels."
        )
    return img.convert("RGB")


def _load_image(src) -> Image.Image:
    """Accept a data URI, http(s) URL, or raw base64 and return an RGB PIL image."""
    if not isinstance(src, str) or not src:
        raise InvalidInputError(
            "'image' must be a non-empty string (data URI or http(s) URL)."
        )

    m = _DATA_URI_RE.match(src)
    if m:
        raw = _decode_base64(m.group(1))
    elif src.startswith(("http://", "https://")):
        raw = _fetch_url(src)
    elif src.startswith("data:"):
        raise InvalidInputError(
            "Unsupported data URI - expected 'data:image/...;base64,<payload>'."
        )
    else:
        # Last-resort: try as raw base64 with no prefix.
        raw = _decode_base64(src)

    return _decode_image(raw)


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------
def _remove_background(image: Image.Image) -> Image.Image:
    orig_size = image.size  # (W, H)
    try:
        tensor = _transform(image).unsqueeze(0).to(DEVICE)
        if DTYPE == torch.float16:
            tensor = tensor.half()

        with torch.inference_mode():
            preds = model(tensor)[-1].sigmoid().float().cpu()
    except torch.cuda.OutOfMemoryError as exc:
        torch.cuda.empty_cache()
        raise InferenceError("GPU out of memory.", detail=str(exc)) from exc
    except RuntimeError as exc:
        # Catches both CUDA runtime errors and generic torch RuntimeErrors.
        if "out of memory" in str(exc).lower():
            torch.cuda.empty_cache()
            raise InferenceError("GPU out of memory.", detail=str(exc)) from exc
        raise InferenceError("Model forward pass failed.", detail=str(exc)) from exc

    mask = preds[0].squeeze()
    mask_pil = transforms.ToPILImage()(mask).resize(orig_size, Image.BILINEAR)

    out = image.copy()
    out.putalpha(mask_pil)
    return out


def _encode_png_data_uri(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ---------------------------------------------------------------------------
# RunPod entry point
# ---------------------------------------------------------------------------
def handler(job):
    job_input = job.get("input") or {}
    if not isinstance(job_input, dict):
        return {"errorInfo": InvalidInputError("'input' must be an object.").to_dict()}

    image_src = job_input.get("image")
    if image_src is None:
        return {"errorInfo": InvalidInputError("Missing required field 'image'.").to_dict()}

    try:
        image = _load_image(image_src)
        result = _remove_background(image)
        return {"image": _encode_png_data_uri(result)}
    except WorkerError as exc:
        logger.warning("Handled error [%s]: %s", exc.code, exc.message)
        # NOTE: must NOT use the top-level key "error" — runpod-python's
        # rp_job.run_job pops `error` from the handler return and the
        # platform dispatcher does not forward it back in the runsync /
        # status response, so the client would see no payload.
        return {"errorInfo": exc.to_dict()}
    except Exception as exc:  # last-resort safety net
        logger.exception("Unhandled error")
        return {
            "errorInfo": {
                "code": "internal_error",
                "message": "Unhandled server error.",
                "detail": f"{type(exc).__name__}: {exc}",
            }
        }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
