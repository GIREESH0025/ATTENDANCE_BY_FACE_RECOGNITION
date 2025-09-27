# app.py - Flask Server for Face Recognition (Redis Version)

import os
import json
import base64
from io import BytesIO
from PIL import Image
import numpy as np
import face_recognition
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import redis # <-- NEW: Import redis library

app = Flask(__name__)
CORS(app)

# --- Redis Database Connection ---
# Render will automatically set the REDIS_URL environment variable.
# For local testing, you would set this in a .env file.
redis_url = os.getenv('REDIS_URL')
if not redis_url:
    print("WARNING: REDIS_URL not set. Falling back to local Redis instance.")
    redis_url = 'redis://localhost:6379'

print(f"Connecting to Redis at: {redis_url.split('@')[-1]}")
# The decode_responses=True flag makes Redis return strings instead of bytes
redis_client = redis.from_url(redis_url, decode_responses=True)

# --- In-Memory Face Database Cache ---
# We load all faces from Redis into this list when the server starts.
# This is much faster than querying Redis for every recognition request.
KNOWN_FACES = [] # List of {'roll': '...', 'encoding': [...]}

def load_faces_from_redis():
    """MODIFIED: Loads all known face encodings from Redis into the in-memory cache."""
    global KNOWN_FACES
    KNOWN_FACES = []
    # Scan for all keys that match our face encoding pattern
    face_keys = redis_client.keys('face_encoding:*')
    
    for key in face_keys:
        try:
            # The key is 'face_encoding:123', so we split to get the roll '123'
            roll = key.split(':')[1]
            # The value is a JSON string of the encoding list
            encoding_json = redis_client.get(key)
            # Convert the JSON string back to a numpy array
            encoding_array = np.array(json.loads(encoding_json))
            
            KNOWN_FACES.append({'roll': roll, 'encoding': encoding_array})
        except (IndexError, json.JSONDecodeError) as e:
            print(f"Error loading key {key}: {e}")
            
    print(f"Loaded {len(KNOWN_FACES)} known face encodings from Redis.")

# --- Utility Functions (No changes needed) ---

def decode_image(base64_string):
    """Decodes a base64 string into a PIL Image object."""
    try:
        if "," in base64_string:
            base64_string = base64_string.split(',')[1]
        image_data = base64.b64decode(base64_string)
        return Image.open(BytesIO(image_data))
    except Exception as e:
        print(f"Error decoding image: {e}")
        return None

# --- API Endpoints ---

@app.route('/')
def home():
    """Serves the main HTML file from the 'templates' folder."""
    return render_template('index.html')

@app.route('/api/add_face', methods=['POST'])
def add_face():
    """MODIFIED: Receives an image, encodes it, and saves it to Redis."""
    data = request.json
    roll = data.get('roll')
    image_b64 = data.get('image')

    if not roll or not image_b64:
        return jsonify({"success": False, "message": "Missing roll or image data"}), 400

    try:
        img = decode_image(image_b64)
        if img is None:
            return jsonify({"success": False, "message": "Invalid image data"}), 400

        rgb_img = np.array(img.convert('RGB'))
        face_locations = face_recognition.face_locations(rgb_img)
        face_encodings = face_recognition.face_encodings(rgb_img, face_locations)

        if not face_encodings:
            return jsonify({"success": False, "message": "No face found in the image."})
        if len(face_encodings) > 1:
            return jsonify({"success": False, "message": "More than one face found. Please capture only one."})

        new_encoding = face_encodings[0]

        # --- Save to Redis ---
        # Convert numpy array to a list, then to a JSON string for storage
        encoding_json = json.dumps(new_encoding.tolist())
        # Store it in Redis with the key 'face_encoding:<roll_number>'
        redis_client.set(f'face_encoding:{roll}', encoding_json)

        # --- Update in-memory cache ---
        # This ensures the new face is immediately recognized without a server restart
        found_in_cache = False
        for item in KNOWN_FACES:
            if item['roll'] == roll:
                item['encoding'] = new_encoding
                found_in_cache = True
                break
        if not found_in_cache:
            KNOWN_FACES.append({'roll': roll, 'encoding': new_encoding})
        
        print(f"Successfully saved/updated encoding for roll {roll} to Redis.")
        return jsonify({"success": True, "message": f"Face encoding saved for Roll: {roll}"})

    except Exception as e:
        print(f"Error in add_face: {e}")
        return jsonify({"success": False, "message": f"Server error during encoding: {str(e)}"}), 500

@app.route('/api/recognize_face', methods=['POST'])
def recognize_face():
    """NO CHANGE: Compares a face against the in-memory cache."""
    data = request.json
    image_b64 = data.get('image')
    
    if not image_b64:
        return jsonify({"success": False, "message": "Missing image data"}), 400
    if not KNOWN_FACES:
        return jsonify({"success": False, "roll": None, "message": "No known faces in database."})

    try:
        img = decode_image(image_b64)
        if img is None:
            return jsonify({"success": False, "message": "Invalid image data"}), 400

        rgb_img = np.array(img.convert('RGB'))
        face_locations = face_recognition.face_locations(rgb_img)
        face_encodings = face_recognition.face_encodings(rgb_img, face_locations)

        if not face_encodings:
            return jsonify({"success": False, "roll": None, "message": "No face detected."})

        # Separate known encodings and rolls from the in-memory cache
        known_encodings = [item['encoding'] for item in KNOWN_FACES]
        known_rolls = [item['roll'] for item in KNOWN_FACES]
        
        # Compare the face from the request with all known faces
        matches = face_recognition.compare_faces(known_encodings, face_encodings[0], tolerance=0.55)
        
        recognized_roll = None
        if True in matches:
            first_match_index = matches.index(True)
            recognized_roll = known_rolls[first_match_index]
        
        if recognized_roll:
            return jsonify({"success": True, "roll": recognized_roll, "message": "Match found!"})
        else:
            return jsonify({"success": False, "roll": None, "message": "No match found in database."})

    except Exception as e:
        print(f"Error in recognize_face: {e}")
        return jsonify({"success": False, "roll": None, "message": f"Server error: {str(e)}"}), 500

if __name__ == '__main__':
    # MODIFIED: Load faces from Redis when the server starts.
    load_faces_from_redis()
    print("\n--- Starting Face Recognition Server ---")
    print("Access the application in your browser at: http://127.0.0.1:5000\n")
    app.run(debug=True, use_reloader=False)
