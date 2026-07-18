import os
import time
import json
import threading
import requests
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, auth, db

app = Flask(__name__)
# Enable CORS for all domains (or restrict it to your chrome extension ID for better security)
CORS(app)

# Load server API keys from environment variable, split by comma
SERVER_KEYS_ENV = os.environ.get("GEMINI_API_KEYS", "")
SERVER_KEYS = [k.strip() for k in SERVER_KEYS_ENV.split(",") if k.strip()]

# Initialize Firebase Admin
firebase_cred_json = os.environ.get("FIREBASE_CREDENTIALS")
if firebase_cred_json:
    try:
        cred_dict = json.loads(firebase_cred_json)
        cred = credentials.Certificate(cred_dict)
        firebase_admin.initialize_app(cred, {
            'databaseURL': 'https://fill-form-b5926-default-rtdb.firebaseio.com'
        })
        print("[*] Firebase Admin initialized successfully.")
        
        # --- Listener for API Keys ---
        def on_api_keys_change(event):
            global SERVER_KEYS
            data = event.data
            if not data:
                SERVER_KEYS = [k.strip() for k in SERVER_KEYS_ENV.split(",") if k.strip()]
                print("[*] API Keys empty in DB. Reverted to ENV keys.")
            elif isinstance(data, dict):
                db_keys = [k for k in data.values() if isinstance(k, str) and k.strip()]
                SERVER_KEYS = db_keys
                print(f"[*] API Keys updated from DB. Loaded {len(SERVER_KEYS)} keys.")
                
        db.reference('settings/api_keys').listen(on_api_keys_change)
    except Exception as e:
        print(f"[!] Failed to initialize Firebase Admin: {e}")
else:
    print("[!] FIREBASE_CREDENTIALS environment variable not set.")

# ---------------------------------------------------------
# ANTI-SLEEP HACK: Background Thread to Ping Itself
# ---------------------------------------------------------
def keep_awake():
    """
    Pings the server itself every 10 minutes to prevent Render free tier from sleeping,
    EXCEPT between 12 AM and 6 AM IST.
    """
    # Render sets RENDER_EXTERNAL_URL in the environment automatically
    render_url = os.environ.get("RENDER_EXTERNAL_URL", "http://127.0.0.1:5000")
    ist_tz = timezone(timedelta(hours=5, minutes=30))
    
    print(f"[*] Started Anti-Sleep thread. Pinging {render_url}/ping every 10 minutes (Pausing 12AM-6AM IST).")
    while True:
        try:
            time.sleep(600)  # Sleep for 10 minutes (600 seconds)
            
            # Check current time in IST
            now_ist = datetime.now(ist_tz)
            
            # If time is between 12:00 AM (0) and 5:59 AM (5), do not ping
            if 0 <= now_ist.hour < 6:
                print(f"[Keep-Awake] Server is in sleep mode (Current time: {now_ist.strftime('%I:%M %p')} IST). Skipping ping.")
                continue
                
            res = requests.get(f"{render_url}/ping", timeout=10)
            print(f"[Keep-Awake] Pinged server: {res.status_code}")
        except Exception as e:
            print(f"[Keep-Awake] Ping failed: {e}")

# Start the thread in daemon mode so it exits when the app stops
threading.Thread(target=keep_awake, daemon=True).start()

# ---------------------------------------------------------
# ENDPOINTS
# ---------------------------------------------------------

@app.route('/ping', methods=['GET'])
def ping():
    """Simple endpoint for the anti-sleep thread and uptime checks."""
    return jsonify({"status": "awake", "time": time.time()}), 200

def verify_and_check_limits(id_token):
    if not firebase_admin._apps:
        return {"error": "Server Firebase misconfigured"}, 500
    try:
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']
        
        user_ref = db.reference(f'users/{uid}')
        user_data = user_ref.get()
        
        if not user_data:
            return {"error": "User profile not found."}, 403
            
        if user_data.get('access') is not True:
            return {"error": "Access Denied by Administrator."}, 403
            
        # Check for personal keys
        personal_keys = []
        personal_keys_str = user_data.get('personalApiKeys')
        if personal_keys_str:
            try:
                import json
                personal_keys_arr = json.loads(personal_keys_str)
                personal_keys = [k.get('key') if isinstance(k, dict) else k for k in personal_keys_arr if (isinstance(k, dict) and k.get('key')) or isinstance(k, str)]
            except:
                pass

        if personal_keys:
            # Bypass limits, they are using their own keys
            return {"uid": uid, "keys_to_try": personal_keys, "used_admin_keys": False}, 200

        # Fallback to Admin keys, check permissions
        if user_data.get('useOwnerKeys') is not True:
            return {"error": "Owner keys disabled. Please use your own keys."}, 403
            
        usage = user_data.get('tokenUsage', 0)
        limit = user_data.get('tokenLimit', 1000000)
        
        if usage >= limit:
            return {"error": "Token limit exceeded."}, 403
            
        global SERVER_KEYS
        return {"uid": uid, "keys_to_try": SERVER_KEYS, "used_admin_keys": True}, 200
    except Exception as e:
        return {"error": f"Invalid ID Token: {e}"}, 401

def increment_personal_usage(uid, count):
    if not count or count <= 0: return
    try:
        usage_ref = db.reference(f'users/{uid}/personalTokenUsage')
        usage_ref.transaction(lambda current_val: (current_val or 0) + count)
    except Exception as e:
        print(f"Failed to increment personal usage for {uid}: {e}")

def increment_usage(uid, count):
    if not count or count <= 0: return
    try:
        usage_ref = db.reference(f'users/{uid}/tokenUsage')
        usage_ref.transaction(lambda current_val: (current_val or 0) + count)
        
        # Track global daily burn rate
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        daily_ref = db.reference(f'analytics/daily_tokens/{today}')
        daily_ref.transaction(lambda current_val: (current_val or 0) + count)
    except Exception as e:
        print(f"Failed to increment usage for {uid}: {e}")

def call_gemini_api(keys_to_try, payload):
    """
    Tries calling the Gemini API with the provided keys one by one.
    Returns the first successful response JSON.
    """
    if not keys_to_try:
        return {"error": "No API keys available."}, 500

    for key in keys_to_try:
        try:
            if key.startswith("AIza"):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key={key}"
                headers = {'Content-Type': 'application/json'}
            else:
                url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent"
                headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
            
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            
            if response.status_code == 200:
                try: db.reference(f'settings/api_keys_health/{key}').set('healthy')
                except: pass
                return response.json(), 200
            else:
                status_health = "rate_limited" if response.status_code == 429 else "invalid"
                try: db.reference(f'settings/api_keys_health/{key}').set(status_health)
                except: pass
                print(f"[Gemini Proxy] Key failed with status {response.status_code}: {response.text}")
                # If rate limited (429) or unauthorized (401), try the next key
                continue
                
        except Exception as e:
            try: db.reference(f'settings/api_keys_health/{key}').set('invalid')
            except: pass
            print(f"[Gemini Proxy] Exception with key: {e}")
            continue
            
    return {"error": "All provided API keys failed or were rate-limited."}, 500

@app.route('/api/gemini/test', methods=['POST'])
def gemini_test():
    data = request.json
    key = data.get("key")
    if not key:
        return jsonify({"error": "No key provided"}), 400
    
    # Use standard 1.5-flash for testing
    if key.startswith("AIza"):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={key}"
        headers = {'Content-Type': 'application/json'}
    else:
        url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
        headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
        
    payload = {"contents": [{"parts": [{"text": "reply ok"}]}]}
    try:
        import requests
        res = requests.post(url, headers=headers, json=payload)
        if res.status_code == 200:
            return jsonify({"status": "valid"}), 200
        else:
            return jsonify({"status": "invalid", "details": res.text}), 400
    except Exception as e:
        return jsonify({"status": "invalid", "error": str(e)}), 500

@app.route('/api/gemini/raw', methods=['POST'])
def gemini_raw():
    """Proxy for raw text generation (e.g. CAPTCHA solving)."""
    data = request.json
    parts = data.get("parts", [])
    user_keys = data.get("userKeys", [])
    id_token = data.get("idToken")
    
    # Try user keys first
    keys_to_try = user_keys[:]
    uid = None
    
    # If using server keys, verify Firebase Auth and check limits
    if id_token and not user_keys:
        verification, status = verify_and_check_limits(id_token)
        if status != 200:
            return jsonify(verification), status
        uid = verification["uid"]
        keys_to_try.extend(SERVER_KEYS)
    elif not user_keys:
        return jsonify({"error": "No API Keys or ID Token provided"}), 401
    
    payload = {
        "contents": [{"parts": parts}]
    }
    
    result, status = call_gemini_api(keys_to_try, payload)
    
    if status == 200:
        try:
            text = result["candidates"][0]["content"]["parts"][0]["text"]
            
            # Increment Token Usage securely
            if uid:
                tokens_used = result.get("usageMetadata", {}).get("totalTokenCount", 0)
                if used_admin:
                    increment_usage(uid, tokens_used)
                else:
                    increment_personal_usage(uid, tokens_used)
                
            return jsonify({"text": text}), 200
        except KeyError:
            return jsonify({"error": "Unexpected API response format."}), 500
    
    return jsonify(result), status

@app.route('/api/gemini/json', methods=['POST'])
def gemini_json():
    """Proxy for JSON-forced generation (e.g. Form Extraction, Smart Fill)."""
    data = request.json
    parts = data.get("parts", [])
    user_keys = data.get("userKeys", [])
    id_token = data.get("idToken")
    
    keys_to_try = user_keys[:]
    uid = None
    used_admin = False
    
    if id_token and not user_keys:
        verification, status = verify_and_check_limits(id_token)
        if status != 200:
            return jsonify(verification), status
        uid = verification["uid"]
        keys_to_try.extend(verification.get("keys_to_try", []))
        used_admin = verification.get("used_admin_keys", False)
    elif not user_keys:
        return jsonify({"error": "No API Keys or ID Token provided"}), 401
    
    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    
    result, status = call_gemini_api(keys_to_try, payload)
    
    if status == 200:
        try:
            text = result["candidates"][0]["content"]["parts"][0]["text"].strip()
            # Clean up markdown code blocks if the API returned them despite JSON response type
            if text.startswith('```json'):
                text = text[7:]
            if text.startswith('```'):
                text = text[3:]
            if text.endswith('```'):
                text = text[:-3]
                
            text = text.strip()
            
            # Verify it's valid JSON before sending back
            parsed_json = json.loads(text)
            
            # Increment Token Usage securely
            if uid:
                tokens_used = result.get("usageMetadata", {}).get("totalTokenCount", 0)
                if used_admin:
                    increment_usage(uid, tokens_used)
                else:
                    increment_personal_usage(uid, tokens_used)
                
            return jsonify(parsed_json), 200
        except (KeyError, json.JSONDecodeError) as e:
            print(f"[Gemini Proxy] JSON Parse Error: {e}\nText received: {result}")
            return jsonify({"error": "Failed to parse JSON from Gemini."}), 500
            
    return jsonify(result), status

if __name__ == '__main__':
    # Render binds to 0.0.0.0 and dynamically assigns a PORT environment variable
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)

def call_gemini_stream_api(keys_to_try, payload):
    if not keys_to_try:
        return {"error": "No API keys available."}, 500

    for key in keys_to_try:
        try:
            if key.startswith("AIza"):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse&key={key}"
                headers = {'Content-Type': 'application/json'}
            else:
                url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse"
                headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
            response = requests.post(url, headers=headers, json=payload, timeout=30, stream=True)
            
            if response.status_code == 200:
                return response, 200
            else:
                continue
        except Exception as e:
            continue
            
    return {"error": "All provided API keys failed or were rate-limited."}, 500

@app.route('/api/gemini/stream', methods=['POST'])
def gemini_stream():
    data = request.json
    parts = data.get("parts", [])
    user_keys = data.get("userKeys", [])
    id_token = data.get("idToken")
    
    keys_to_try = user_keys[:]
    uid = None
    used_admin = False
    
    if id_token and not user_keys:
        verification, status = verify_and_check_limits(id_token)
        if status != 200:
            return jsonify(verification), status
        uid = verification["uid"]
        keys_to_try.extend(verification.get("keys_to_try", []))
        used_admin = verification.get("used_admin_keys", False)
    elif not user_keys:
        return jsonify({"error": "No API Keys or ID Token provided"}), 401
    
    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    
    response, status = call_gemini_stream_api(keys_to_try, payload)
    
    if status == 200:
        def generate():
            for chunk in response.iter_content(chunk_size=1024):
                if chunk:
                    # Attempt to extract usage from chunk (it's JSON stream, usage might be at the end)
                    try:
                        import json
                        chunk_str = chunk.decode('utf-8')
                        if 'usageMetadata' in chunk_str and uid:
                            # It's an SSE stream, so lines start with 'data: '
                            for line in chunk_str.splitlines():
                                if line.startswith('data: '):
                                    data_obj = json.loads(line[6:])
                                    if 'usageMetadata' in data_obj:
                                        tokens = data_obj['usageMetadata'].get('totalTokenCount', 0)
                                        if used_admin:
                                            increment_usage(uid, tokens)
                                        else:
                                            increment_personal_usage(uid, tokens)
                    except:
                        pass
                    yield chunk
        return app.response_class(generate(), mimetype='text/event-stream')
    
    return jsonify(response), status
