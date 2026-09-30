# S9 at-risk classifier (offline evaluation job; never part of detection). Build context: ml/at_risk.
FROM python:3.12.11-slim-bookworm
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY export.py train.py ./
RUN useradd --create-home --uid 10001 app
USER app
ENTRYPOINT ["python"]
