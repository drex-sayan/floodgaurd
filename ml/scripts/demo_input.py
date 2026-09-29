from pathlib import Path
import pandas as pd
import json
root=Path(__file__).resolve().parents[1]
df=pd.read_csv(root/'data'/'M3_test.csv')
features=[
    'station_id','latitude','longitude','elevation_m','slope_deg',
    'rainfall_1h','rainfall_3h','rainfall_6h','rainfall_12h','rainfall_24h',
    'soil_moisture','moisture_change_3h','water_level_m','water_level_lag1h',
    'water_level_lag3h','water_level_lag6h','water_level_change_1h',
    'water_level_change_3h','rise_rate_m_per_hour','recent_event_count','event_proximity_km'
]
r=df.iloc[-1]
p={k:float(r[k]) for k in features}
Path(root/'demo_input.json').write_text(json.dumps(p,indent=2))
print(json.dumps(p,indent=2))
