RISK_BANDS = (
    (0.30, 'LOW', 'No immediate high-risk signal from M3'),
    (0.60, 'MODERATE', 'Conditions warrant monitoring'),
    (0.80, 'HIGH', 'Elevated flash-flood likelihood'),
    (1.01, 'EXTREME', 'Very high predicted likelihood; trigger strong prototype warning'),
)

def risk_from_probability(probability: float):
    p = float(probability)
    if p < 0.30:
        return 'LOW', 'No immediate high-risk signal from M3'
    if p < 0.60:
        return 'MODERATE', 'Conditions warrant monitoring'
    if p < 0.80:
        return 'HIGH', 'Elevated flash-flood likelihood'
    return 'EXTREME', 'Very high predicted likelihood; trigger strong prototype warning'
