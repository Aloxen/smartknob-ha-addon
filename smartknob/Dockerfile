FROM python:3.12-alpine

# Install dependencies
RUN pip install --no-cache-dir aiohttp pyyaml

WORKDIR /app

# Copy application files
COPY app /app

EXPOSE 8099

CMD ["python3", "-u", "/app/backend/server.py"]
