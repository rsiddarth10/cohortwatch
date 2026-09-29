# syntax=docker/dockerfile:1
# Batch analytics job (S3): each van's normal + fault-rate table from the history lake.
# Build context: batch/baselines.   docker build -t cohortwatch/baselines:dev batch/baselines
FROM python:3.12.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/home/app
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
USER app
# DuckDB extensions are installed at build time, so the job needs no internet at run time.
RUN python -c "import duckdb; c = duckdb.connect(); c.install_extension('httpfs'); c.install_extension('postgres')"
COPY baselines.py .
# No data/sim-private here: the job reads the lake and writes as cw_app; it never sees ground truth.
CMD ["python", "baselines.py"]
