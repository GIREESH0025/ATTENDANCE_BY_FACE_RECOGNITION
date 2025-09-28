from flask import Flask, render_template, request, jsonify
import os
import json
import base64
import numpy as np
from PIL import Image
import face_recognition
import io

# Try Valkey (Redis-compatible) else fallback to JSON
VALKEY_URL = os.getenv("VALKEY_URL")
faces_db = {}
if VALKEY_URL:
    import redis
    redis_client = redis.from_url(VALKEY_URL)
else:
    redis_client = None

app = Flask(__name__)

# ------------------ Face DB (keyed by Roll Number) ------------------
def load_faces():
    """Loads faces from Redis or a local JSON file."""
    global faces_db
    if redis_client:
        all_keys = redis_client.keys("face:*")
        for key in all_keys:
            roll = key.decode().split(":", 1)[1]
            faces_db[roll] = json.loads(redis_client.get(key).decode())
        print(f"Loaded {len(faces_db)} faces from Redis.")
    else:
        if os.path.exists("face_encodings.json"):
            with open("face_encodings.json", "r") as f:
                faces_db = json.load(f)
            print(f"Loaded {len(faces_db)} faces from face_encodings.json.")

def save_face(roll, encoding):
    """Saves a single face encoding to the database."""
    global faces_db
    faces_db[roll] = encoding.tolist()
    if redis_client:
        redis_client.set(f"face:{roll}", json.dumps(encoding.tolist()))
    else:
        with open("face_encodings.json", "w") as f:
            json.dump(faces_db, f)
    print(f"Saved encoding for roll: {roll}")


load_faces()

# ------------------ Routes ------------------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/add_face", methods=["POST"])
def add_face():
    """Receives image and roll number, then saves the face encoding."""
    data = request.json
    # FIX: Trim whitespace from the incoming roll number before using it.
    roll = data.get("roll", "").strip()
    image_data = data.get("image")

    if not roll or not image_data:
        return jsonify({"status": "error", "message": "Missing roll number or image"}), 400

    try:
        img_bytes = base64.b64decode(image_data.split(",")[1])
        img = Image.open(io.BytesIO(img_bytes))
        rgb_img = np.array(img.convert("RGB"))

        encodings = face_recognition.face_encodings(rgb_img)
        if len(encodings) != 1:
            return jsonify({"status": "error", "message": "Image must contain exactly one clear face"}), 400

        save_face(roll, encodings[0])
        return jsonify({"status": "success", "message": f"Face enrolled for Roll No: {roll}"})
    except Exception as e:
        print(f"Error in add_face: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/api/recognize_face", methods=["POST"])
def recognize_face():
    """Receives an image and returns the roll number of the recognized face."""
    data = request.json
    image_data = data.get("image")
    if not image_data:
        return jsonify({"status": "error", "message": "Missing image"}), 400

    if not faces_db:
        return jsonify({"status": "error", "message": "No faces enrolled in the database"})
        
    try:
        img_bytes = base64.b64decode(image_data.split(",")[1])
        img = Image.open(io.BytesIO(img_bytes))
        rgb_img = np.array(img.convert("RGB"))

        unknown_encodings = face_recognition.face_encodings(rgb_img)
        if not unknown_encodings:
            return jsonify({"status": "error", "message": "No face detected in the image"})

        unknown_encoding = unknown_encodings[0]
        known_encodings = [np.array(v) for v in faces_db.values()]
        known_rolls = list(faces_db.keys())

        matches = face_recognition.compare_faces(known_encodings, unknown_encoding, tolerance=0.55)
        
        if True in matches:
            first_match_index = matches.index(True)
            matched_roll = known_rolls[first_match_index]
            print(f"Match found! Roll: {matched_roll}")
            # FIX: Ensure the returned roll number is also trimmed.
            return jsonify({"status": "success", "roll": matched_roll.strip()})
        
        print("No match found for the provided face.")
        return jsonify({"status": "error", "message": "Unknown face. Not found in database."})

    except Exception as e:
        print(f"Error in recognize_face: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True)
