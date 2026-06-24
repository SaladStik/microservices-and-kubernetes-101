# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
FROM python:3.12-slim

WORKDIR /app

# deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# run as non root, some hardened clusters require it
RUN useradd --no-create-home --uid 10001 worker
USER worker

CMD ["python", "-m", "app.main"]
