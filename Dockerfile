FROM runpod/base:0.6.3-cuda12.1.0

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_CACHE=/root/.cache/huggingface/hub

# Use Python 3.11 from the base image as the default `python`.
RUN ln -sf /usr/bin/python3.11 /usr/local/bin/python && \
    ln -sf /usr/bin/python3.11 /usr/local/bin/python3

# ---------------------------------------------------------------------------
# Python dependencies
# ---------------------------------------------------------------------------
COPY requirements.txt /requirements.txt
RUN python -m pip install --upgrade pip && \
    python -m pip install --no-cache-dir -r /requirements.txt

# ---------------------------------------------------------------------------
# Pre-download RMBG-2.0 weights + custom code into the image
#   - briaai/RMBG-2.0 is a GATED repo. Pass an HF token at build time:
#       docker build --secret id=hf_token,env=HF_TOKEN -t worker-rmbg20 .
#   - Only safetensors + JSON + .py (skip pytorch_model.bin + onnx/*).
#   - Then instantiate once so trust_remote_code modules are cached.
#   - Secret is mounted as a tmpfs file and never written to a layer.
# ---------------------------------------------------------------------------
RUN --mount=type=secret,id=hf_token,required=true \
    HF_TOKEN="$(cat /run/secrets/hf_token)" \
    python -c "from huggingface_hub import snapshot_download; \
snapshot_download(repo_id='briaai/RMBG-2.0', \
allow_patterns=['*.json', '*.py', 'model.safetensors'])" && \
    HF_TOKEN="$(cat /run/secrets/hf_token)" \
    python -c "from transformers import AutoModelForImageSegmentation; \
AutoModelForImageSegmentation.from_pretrained('briaai/RMBG-2.0', trust_remote_code=True)"

# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
COPY handler.py /handler.py

CMD ["python", "-u", "/handler.py"]
