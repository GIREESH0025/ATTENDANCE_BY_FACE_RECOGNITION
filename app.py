# app.py - Flask Server for Face Recognition

import os
import json
import base64
from io import BytesIO
from PIL import Image
import numpy as np
import face_recognition
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS

app = Flask(__name__)
CORS(app) # Enable CORS for development

# --- Face Database Management ---
FACE_DB_PATH = 'face_encodings.json'
KNOWN_FACES = [] # List of {'roll': '...', 'encoding': [...]}

def load_face_db():
    """Loads known face encodings from a JSON file."""
    global KNOWN_FACES
    if os.path.exists(FACE_DB_PATH):
        try:
            with open(FACE_DB_PATH, 'r') as f:
                data = json.load(f)
                KNOWN_FACES = [
                    {'roll': item['roll'], 'encoding': np.array(item['encoding'])}
                    for item in data
                ]
            print(f"Loaded {len(KNOWN_FACES)} known face encodings.")
        except (json.JSONDecodeError, IOError) as e:
            print(f"Error loading face database: {e}. Starting with an empty database.")
            KNOWN_FACES = []
    else:
        KNOWN_FACES = []
        print("No existing face database found. It will be created on the first addition.")

def save_face_db():
    """Saves known face encodings to a JSON file."""
    serializable_data = [
        {'roll': item['roll'], 'encoding': item['encoding'].tolist()}
        for item in KNOWN_FACES
    ]
    with open(FACE_DB_PATH, 'w') as f:
        json.dump(serializable_data, f, indent=4)
    print(f"Saved {len(KNOWN_FACES)} known face encodings to {FACE_DB_PATH}.")


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
    """Receives an image and roll, encodes the face, and saves it."""
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
        found = False
        for item in KNOWN_FACES:
            if item['roll'] == roll:
                item['encoding'] = new_encoding
                found = True
                break

        if not found:
            KNOWN_FACES.append({'roll': roll, 'encoding': new_encoding})

        save_face_db()
        return jsonify({"success": True, "message": f"Face encoding saved for Roll: {roll}"})

    except Exception as e:
        print(f"Error in add_face: {e}")
        return jsonify({"success": False, "message": f"Server error during encoding: {str(e)}"}), 500


@app.route('/api/recognize_face', methods=['POST'])
def recognize_face():
    """Receives an image and compares it against the known faces."""
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

        known_encodings = [item['encoding'] for item in KNOWN_FACES]
        known_rolls = [item['roll'] for item in KNOWN_FACES]

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
    load_face_db()
    print("\n--- Starting Face Recognition Server ---")
    print("Access the application in your browser at: http://127.0.0.1:5000\n")
    # Using use_reloader=False can improve stability during development
    app.run(debug=True, use_reloader=False)