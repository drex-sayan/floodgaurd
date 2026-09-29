import json
import sys
from pathlib import Path
import joblib
import pandas as pd

ROOT = Path(__file__).resolve().parent
ART = ROOT / "artifacts"

M3_FEATURES = [
    "station_id","latitude","longitude","elevation_m","slope_deg",
    "rainfall_1h","rainfall_3h","rainfall_6h","rainfall_12h","rainfall_24h",
    "soil_moisture","moisture_change_3h","water_level_m","water_level_lag1h",
    "water_level_lag3h","water_level_lag6h","water_level_change_1h",
    "water_level_change_3h","rise_rate_m_per_hour","recent_event_count",
    "event_proximity_km"
]
M5_FEATURES = M3_FEATURES
M4_FEATURES = [
    "slope_deg","elevation_m","land_cover_code","geology_code",
    "rainfall_1h","rainfall_3h","rainfall_6h","rainfall_12h","rainfall_24h",
    "soil_moisture","moisture_change_3h"
]

m3 = m3meta = None
m4 = m4meta = None
m5 = m5meta = None

def load_m3():
    global m3, m3meta
    if m3 is None:
        m3 = joblib.load(ART / "M3_calibrated_model.joblib")
        m3meta = json.loads((ART / "model_metadata.json").read_text())
    return m3, m3meta

def load_m4():
    global m4, m4meta
    if m4 is None:
        m4 = joblib.load(ART / "M4_calibrated_model.joblib")
        m4meta = json.loads((ART / "M4_model_metadata.json").read_text())
    return m4, m4meta

def load_m5():
    global m5, m5meta
    if m5 is None:
        m5 = joblib.load(ART / "M5_forecast_model.joblib")
        m5meta = json.loads((ART / "M5_model_metadata.json").read_text())
    return m5, m5meta

def risk(prob):
    if prob < .30: return "LOW", "Low probability of flash-flood signal"
    if prob < .60: return "MODERATE", "Conditions warrant awareness"
    if prob < .80: return "HIGH", "Elevated flash-flood signal"
    return "EXTREME", "Very high flash-flood signal on this synthetic model"

def m3_predict(p):
    from scripts.risk_engine import risk_from_probability
    model, meta = load_m3()
    missing = [f for f in M3_FEATURES if f not in p]
    if missing: raise ValueError("Missing required features: " + ", ".join(missing))
    row = {f: float(p[f]) for f in M3_FEATURES}
    prob = float(model.predict_proba(pd.DataFrame([row], columns=M3_FEATURES))[0,1])
    r, meaning = risk_from_probability(prob)
    return {"model_version": meta["model_version"], "flood_probability": prob,
            "risk_level": r, "risk_meaning": meaning,
            "prediction_window": m3meta["prediction_window"], "data_quality": 1.0}

def m4_predict(p):
    model, meta = load_m4()
    numeric = ["slope_deg","elevation_m","rainfall_1h","rainfall_3h","rainfall_6h","rainfall_12h","rainfall_24h","soil_moisture","moisture_change_3h"]
    missing=[f for f in numeric if f not in p]
    if missing: raise ValueError("Missing required features: " + ", ".join(missing))
    lc = meta["categorical_encodings"]["land_cover"]
    geo = meta["categorical_encodings"]["geology"]
    row={f:float(p[f]) for f in numeric}
    row["land_cover_code"]=lc.get(p.get("land_cover"), lc["forest"])
    row["geology_code"]=geo.get(p.get("geology"), geo["sedimentary"])
    prob=float(model.predict_proba(pd.DataFrame([row],columns=M4_FEATURES))[0,1])
    if prob<.30: r,meaning="LOW","No strong landslide-hazard signal from M4"
    elif prob<.60: r,meaning="MODERATE","Conditions warrant awareness"
    elif prob<.80: r,meaning="HIGH","Elevated landslide-hazard signal"
    else: r,meaning="EXTREME","Very high hazard signal on this synthetic model — treat as context only"
    return {"model_version":meta["model_version"],"landslide_probability":round(prob,4),
            "risk_level":r,"risk_meaning":meaning,"data_is_synthetic":bool(meta["data_is_synthetic"])}

def m5_predict(p):
    model, meta = load_m5()
    missing=[f for f in M5_FEATURES if f not in p]
    if missing: raise ValueError("Missing required features: " + ", ".join(missing))
    row={f:float(p[f]) for f in M5_FEATURES}
    pred=model.predict(pd.DataFrame([row],columns=M5_FEATURES))[0]
    return {"model_version":meta["model_version"],"forecast_1h":round(float(pred[0]),3),
            "forecast_3h":round(float(pred[1]),3),"forecast_6h":round(float(pred[2]),3),
            "data_is_synthetic":bool(meta["data_is_synthetic"])}

def versions():
    m3_exists = (ART / "M3_calibrated_model.joblib").exists() and (ART / "model_metadata.json").exists()
    m4_exists = (ART / "M4_calibrated_model.joblib").exists() and (ART / "M4_model_metadata.json").exists()
    m5_exists = (ART / "M5_forecast_model.joblib").exists() and (ART / "M5_model_metadata.json").exists()
    result = [
        {"module":"M1","model_version":None,"module_version":"M1-v0.1","artifact":"ml/m1/estimate_level.py","available":True,"data_is_synthetic":True,"type":"calibration/edge-detection prototype; no trained model"},
        {"module":"M2","model_version":None,"module_version":"M2-v0.1","artifact":"services/m2Detect.js","available":True,"data_is_synthetic":True,"type":"rule-based anomaly detector; no trained model"},
        {"module":"M3","model_version":"M3-v1.0","artifact":"ml/artifacts/M3_calibrated_model.joblib","available":m3_exists,"data_is_synthetic":True},
        {"module":"M4","model_version":"M4-v1.0","artifact":"ml/artifacts/M4_calibrated_model.joblib","available":m4_exists,"data_is_synthetic":True},
        {"module":"M5","model_version":"M5-v1.0","artifact":"ml/artifacts/M5_forecast_model.joblib","available":m5_exists,"data_is_synthetic":True},
    ]
    return result

print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        req=json.loads(line)
        model_name=req.get("model")
        if model_name=="versions": result=versions()
        else:
            data=req.get("data", req)
            if model_name=="m3": result=m3_predict(data)
            elif model_name=="m4": result=m4_predict(data)
            elif model_name=="m5": result=m5_predict(data)
            else: raise ValueError("Unknown inference model.")
        print(json.dumps({"id":req.get("id"),"ok":True,"result":result}),flush=True)
    except Exception as e:
        print(json.dumps({"id":req.get("id"),"ok":False,"error":str(e)}),flush=True)
