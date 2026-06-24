# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
"""Entry point. Build config, run the consumer. The core loop is in consumer.py."""
from app.config import Config
from app.consumer import run

if __name__ == "__main__":
    raise SystemExit(run(Config.from_env()))
