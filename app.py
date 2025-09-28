import os
import json
import base64
from io import BytesIO
from PIL import Image
import numpy as np
import face_recognition
from flask import Flask, request, jsonify, render_template

app = Flask(__name__)

# --- Face Database Management ---
FACE_DB_PATH = 'face_encodings.json'
KNOWN_FACES = []

def load_face_db():
    """
    Loads known face encodings from a JSON file.
    This corrected version handles errors and ensures the data is a list of dicts.
    """
    global KNOWN_FACES
    if os.path.exists(FACE_DB_PATH):
        try:
            with open(FACE_DB_PATH, 'r') as f:
                data = json.load(f)
                # Ensure data is a list of dictionaries with 'roll' and 'encoding'
                if isinstance(data, list) and all('roll' in item and 'encoding' in item for item in data):
                    KNOWN_FACES = [
                        {'roll': item['roll'], 'encoding': np.array(item['encoding'])}
                        for item in data
                    ]
                    print(f"Loaded {len(KNOWN_FACES)} known face encodings.")
                else:
                    raise ValueError("JSON format is incorrect.")
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            # If the file is corrupted or in the wrong format, start fresh
            print(f"Error reading {FACE_DB_PATH}: {e}. Starting with an empty database.")
            KNOWN_FACES = []
    else:
        KNOWN_FACES = []
        print("No existing face database found. A new one will be created.")

def save_face_db():
    """
    Saves known face encodings to a JSON file.
    This corrected version ensures data is saved as a list of dictionaries.
    """
    serializable_data = [
        {'roll': item['roll'], 'encoding': item['encoding'].tolist()}
        for item in KNOWN_FACES
    ]
    with open(FACE_DB_PATH, 'w') as f:
        json.dump(serializable_data, f, indent=2)
    print(f"Saved {len(KNOWN_FACES)} face encodings to {FACE_DB_PATH}.")

# --- Utility Functions ---
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
    """Receives an image, encodes it, and saves it."""
    data = request.json
    roll = data.get('roll')
    image_b64 = data.get('image')

    if not roll or not image_b64:
        return jsonify({"status": "error", "message": "Missing roll or image data"}), 400

    try:
        img = decode_image(image_b64)
        if img is None:
            return jsonify({"status": "error", "message": "Invalid image data"}), 400

        rgb_img = np.array(img.convert('RGB'))
        face_locations = face_recognition.face_locations(rgb_img)
        face_encodings = face_recognition.face_encodings(rgb_img, face_locations)

        if not face_encodings:
            return jsonify({"status": "error", "message": "No face found in the image."})
        if len(face_encodings) > 1:
            return jsonify({"status": "error", "message": "More than one face found."})

        new_encoding = face_encodings[0]
        
        found = False
        for item in KNOWN_FACES:
            if item['roll'] == roll:
                item['encoding'] = new_encoding
                found = True
                break
        
        if not found:
            KNOWN_FACES.append({'roll': roll, 'encoding': new_encoding})

        save_face_db()
        return jsonify({"status": "success", "message": f"Face for Roll {roll} saved."})

    except Exception as e:
        print(f"Error in add_face: {e}")
        return jsonify({"status": "error", "message": f"Server error: {str(e)}"}), 500

@app.route('/api/recognize_face', methods=['POST'])
def recognize_face():
    """Receives an image and compares it against the known faces."""
    data = request.json
    image_b64 = data.get('image')
    
    if not image_b64:
        return jsonify({"status": "error", "message": "Missing image data"}), 400
    if not KNOWN_FACES:
        return jsonify({"status": "error", "roll": None, "message": "No faces in database."})

    try:
        img = decode_image(image_b64)
        if img is None:
            return jsonify({"status": "error", "message": "Invalid image data"}), 400

        rgb_img = np.array(img.convert('RGB'))
        face_locations = face_recognition.face_locations(rgb_img)
        face_encodings = face_recognition.face_encodings(rgb_img, face_locations)

        if not face_encodings:
            return jsonify({"status": "error", "roll": None, "message": "No face detected."})

        known_encodings = [item['encoding'] for item in KNOWN_FACES]
        known_rolls = [item['roll'] for item in KNOWN_FACES]

        matches = face_recognition.compare_faces(known_encodings, face_encodings[0], tolerance=0.55)
        
        recognized_roll = None
        if True in matches:
            first_match_index = matches.index(True)
            recognized_roll = known_rolls[first_match_index]
        
        if recognized_roll:
            return jsonify({"status": "success", "roll": recognized_roll, "message": "Match found!"})
        else:
            return jsonify({"status": "error", "roll": None, "message": "No match found."})

    except Exception as e:
        print(f"Error in recognize_face: {e}")
        return jsonify({"status": "error", "roll": None, "message": f"Server error: {str(e)}"}), 500

if __name__ == '__main__':
    load_face_db()
    app.run(host='0.0.0.0', port=5000, debug=True)
