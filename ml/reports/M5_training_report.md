# FloodGuard M5-v1.0 Training Report

Supporting module — output does not change M3's flash-flood probability.

Dataset: synthetic stand-in (see ml/m5/mock_m3_fallback.py)

Target: water_level_m at +1h / +3h / +6h

## Split sizes

- Train: 8,376
- Validation: 1,776
- Test: 1,776

## Train

| Horizon | MAE (m) | RMSE (m) | n |
|---|---:|---:|---:|
| +1h | 0.0136 | 0.0173 | 8376 |
| +3h | 0.0240 | 0.0319 | 8376 |
| +6h | 0.0372 | 0.0518 | 8376 |

## Validation

| Horizon | MAE (m) | RMSE (m) | n |
|---|---:|---:|---:|
| +1h | 0.0182 | 0.0229 | 1776 |
| +3h | 0.0335 | 0.0436 | 1776 |
| +6h | 0.0540 | 0.0723 | 1776 |

## Test

| Horizon | MAE (m) | RMSE (m) | n |
|---|---:|---:|---:|
| +1h | 0.0175 | 0.0222 | 1776 |
| +3h | 0.0324 | 0.0417 | 1776 |
| +6h | 0.0547 | 0.0727 | 1776 |

## Important limitation

The dataset and target are synthetic. Metrics demonstrate that the training/inference pipeline works correctly; they do not establish real-world water-level forecasting accuracy. M5 is a supporting module only and its output never feeds into M3's flash-flood probability or the Zone Engine.
