# FloodGuard M3 ML Pipeline

This folder contains the complete M3 mock-data training pipeline aligned with the FloodGuard simplified architecture.

## Run training

From the project root:

```bash
python ml/scripts/train_m3.py
```

This trains Random Forest M3-v1.0, calibrates probabilities on the validation period, selects a validation decision threshold, evaluates on the untouched chronological test period, and writes model artifacts/reports.

## Run a prediction

```bash
python ml/scripts/predict_m3.py < ml/demo_input.json
```

## Important

The dataset and target are synthetic/mock. They are for development and integration testing only. Replace the mock event labels with verified historical flood-event labels before claiming real-world model performance.

The M3 target is `flash_flood_next_3h`, not `target_water_level_3h`. Future-looking values must never be used as model inputs.
