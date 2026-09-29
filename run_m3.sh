#!/usr/bin/env bash
set -euo pipefail
python ml/scripts/train_m3.py
python ml/scripts/demo_input.py
python ml/scripts/predict_m3.py < ml/demo_input.json
