# FloodGuard M3-v1.0 Training Report

Dataset: synthetic/mock
Target: flash_flood_next_3h
Prediction window: next 1–3 hours

## Split sizes

- Train: 8,400
- Validation: 1,800
- Test: 1,800

## Selected validation threshold

0.6217

## Train

| Metric | Value |
|---|---:|
| Accuracy | 0.9993 |
| Precision | 0.9956 |
| Recall | 0.9991 |
| F1 | 0.9974 |
| ROC-AUC | 1.0000 |
| PR-AUC | 1.0000 |
| Brier score | 0.0009 |
| TP | 1144 |
| FP | 5 |
| FN | 1 |
| TN | 7250 |

## Validation

| Metric | Value |
|---|---:|
| Accuracy | 0.9956 |
| Precision | 0.9941 |
| Recall | 0.9825 |
| F1 | 0.9882 |
| ROC-AUC | 0.9997 |
| PR-AUC | 0.9987 |
| Brier score | 0.0040 |
| TP | 336 |
| FP | 2 |
| FN | 6 |
| TN | 1456 |

## Test

| Metric | Value |
|---|---:|
| Accuracy | 0.9933 |
| Precision | 0.9800 |
| Recall | 0.9608 |
| F1 | 0.9703 |
| ROC-AUC | 0.9988 |
| PR-AUC | 0.9924 |
| Brier score | 0.0065 |
| TP | 196 |
| FP | 4 |
| FN | 8 |
| TN | 1592 |

## Risk mapping

Probability is mapped to the prototype LOW/MODERATE/HIGH/EXTREME bands defined in the architecture. These are visualization thresholds, not official emergency thresholds.

## Important limitation

The dataset and target are synthetic. Metrics demonstrate that the pipeline trains and evaluates correctly; they do not establish real-world flood prediction performance.
