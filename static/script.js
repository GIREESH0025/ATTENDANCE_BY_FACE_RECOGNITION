document.addEventListener('DOMContentLoaded', () => {

    // ---------- IndexedDB Setup and NEW Robust Helpers ----------
    const DB_NAME = 'FaceAttendanceDB';
    const DB_VERSION = 1;
    const STORE_STUDENTS = 'students';
    const STORE_ATTENDANCE = 'attendance';
    let dbPromise;

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_STUDENTS)) {
                    db.createObjectStore(STORE_STUDENTS, { keyPath: 'roll' });
                }
                if (!db.objectStoreNames.contains(STORE_ATTENDANCE)) {
                    const store = db.createObjectStore(STORE_ATTENDANCE, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('roll_date_idx', ['roll', 'date'], { unique: false });
                }
            };
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    // NEW robust helper for GET requests
    function dbGet(storeName, key) {
        return new Promise(async (resolve, reject) => {
            const db = await dbPromise;
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = key ? store.get(key) : store.getAll();
            // Resolve the promise on the request's success event
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    // NEW robust helper for PUT/ADD requests
    function dbPut(storeName, data) {
        return new Promise(async (resolve, reject) => {
            const db = await dbPromise;
            const transaction = db.transaction(storeName, 'readwrite');
            transaction.objectStore(storeName).put(data);
            // Resolve the promise on the transaction's complete event
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject(event.target.error);
        });
    }
    
    // Simpler function definitions
    const loadStudents = () => dbGet(STORE_STUDENTS);
    const saveStudent = (student) => dbPut(STORE_STUDENTS, student);
    const loadAttendance = () => dbGet(STORE_ATTENDANCE);
    const saveAttendanceRecord = (record) => dbPut(STORE_ATTENDANCE, record);

    const saveWorkingDays = (val) => localStorage.setItem('workingDays', val);
    const loadWorkingDays = () => parseInt(localStorage.getItem('workingDays') || '22');

    // ---------- App Initialization ----------
    async function initialize() {
        dbPromise = openDB();
        await dbPromise;
        console.log("Database connection successful.");

        setupTabNavigation();
        setupEnrollment();
        setupRecognition();
        setupManualAttendance();
        setupReports();

        startCamera('video');
        startCamera('scanVideo');

        document.querySelector('nav button').click();
    }

    // ---------- Event Listener Setup Functions ----------
    function setupTabNavigation() {
        const tabs = document.querySelectorAll('.tab-content');
        const navButtons = document.querySelectorAll('nav button');
        navButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                tabs.forEach(t => t.classList.add('hidden'));
                navButtons.forEach(b => b.classList.remove('active'));
                document.getElementById(btn.dataset.tab).classList.remove('hidden');
                btn.classList.add('active');

                if (btn.dataset.tab === 'reports') {
                    document.getElementById('workingDays').value = loadWorkingDays();
                    await populateMonthSelector();
                    await handleGenerateReport();
                }
            });
        });
    }

    function setupEnrollment() { document.getElementById('enrollBtn').addEventListener('click', handleEnroll); }
    function setupRecognition() { document.getElementById('scanBtn').addEventListener('click', handleScan); }
    function setupManualAttendance() { document.getElementById('manualMarkBtn').addEventListener('click', handleManualMark); }
    function setupReports() {
        document.getElementById('generateReportBtn').addEventListener('click', handleGenerateReport);
        document.getElementById('exportIndividualCsvBtn').addEventListener('click', handleExportIndividualCSV);
    }

    // ---------- Handler Functions ----------
    async function handleEnroll() {
        const roll = document.getElementById('studentRoll').value.trim();
        const name = document.getElementById('studentName').value.trim();
        const sClass = document.getElementById('studentClass').value.trim();
        const statusEl = document.getElementById('enrollStatus');

        if (!roll || !name || !sClass) {
            alert("Please fill in Roll Number, Name, and Class.");
            return;
        }

        statusEl.innerText = "Capturing and processing...";
        const img = captureImage('video');

        try {
            const res = await fetch("/api/add_face", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ roll, image: img })
            });
            const data = await res.json();
            statusEl.innerText = data.message;

            if (data.status === "success") {
                await saveStudent({ roll, name, class: sClass });
                speak("Student enrolled successfully.");
            } else {
                speak("Enrollment failed.");
            }
        } catch (error) {
            console.error("Enrollment error:", error);
            statusEl.innerText = "Error during enrollment. Check console.";
        }
    }

    async function handleScan() {
        const statusEl = document.getElementById('scanStatus');
        statusEl.innerText = "Recognizing face...";
        const img = captureImage('scanVideo');

        try {
            const res = await fetch("/api/recognize_face", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: img })
            });
            const data = await res.json();

            if (data.status === "success" && data.roll) {
                await markAttendance(data.roll.trim(), 'scanStatus');
            } else {
                statusEl.innerText = `❌ ${data.message}`;
                speak("Recognition failed.");
            }
        } catch (error) {
            console.error("Recognition error:", error);
            statusEl.innerText = "Error connecting to server.";
        }
    }

    async function handleManualMark() {
        const roll = document.getElementById('manualRoll').value.trim();
        if (!roll) {
            alert("Please enter a roll number.");
            return;
        }
        await markAttendance(roll, 'manualStatus');
        document.getElementById('manualRoll').value = '';
    }

    async function markAttendance(roll, statusElId) {
        const statusEl = document.getElementById(statusElId);
        const today = new Date().toISOString().split('T')[0];

        try {
            const student = await dbGet(STORE_STUDENTS, roll);
            if (!student) {
                statusEl.innerText = `❌ Roll Number "${roll}" not found in browser DB.`;
                speak("Student not enrolled.");
                return;
            }

            const allAttendance = await loadAttendance();
            const alreadyMarked = allAttendance.find(r => r.roll === roll && r.date === today);

            if (alreadyMarked) {
                statusEl.innerText = `⚠️ Attendance already marked for ${student.name}.`;
                speak(`Attendance already marked for ${student.name}.`);
            } else {
                await saveAttendanceRecord({ roll: student.roll, name: student.name, class: student.class, time: new Date().toLocaleString(), date: today });
                statusEl.innerText = `✅ Attendance marked for ${student.name}.`;
                speak(`Attendance marked for ${student.name}.`);
            }
        } catch (error) {
            console.error("Mark Attendance DB Error:", error);
            statusEl.innerText = "❌ A database error occurred.";
        }
    }
    
    // --- Report and UI Rendering ---
    async function populateMonthSelector() {
        const monthSelect = document.getElementById('reportMonth');
        const recs = await loadAttendance();
        const monthSet = new Set(recs.map(r => r.date.substring(0, 7)));
        const sortedMonths = Array.from(monthSet).sort().reverse();
        
        monthSelect.innerHTML = '<option value="all">All Months</option>' + sortedMonths.map(month => {
            const [year, monthNum] = month.split('-');
            const monthName = new Date(year, monthNum - 1, 1).toLocaleString('default', { month: 'long' });
            return `<option value="${month}">${monthName} ${year}</option>`;
        }).join('');
    }

    async function calculateReportData(selectedMonth) {
        let attendance = await loadAttendance();
        if (selectedMonth !== 'all') {
            attendance = attendance.filter(r => r.date.startsWith(selectedMonth));
        }
        
        const students = await loadStudents();
        const workingDays = parseInt(document.getElementById('workingDays').value) || 0;
        saveWorkingDays(workingDays);

        const attendanceCounts = new Map(students.map(s => [s.roll, { ...s, attended: 0 }]));

        attendance.forEach(r => {
            if (attendanceCounts.has(r.roll)) {
                attendanceCounts.get(r.roll).attended++;
            }
        });

        const studentRows = Array.from(attendanceCounts.values()).map(data => {
            const percentage = workingDays > 0 ? ((data.attended / workingDays) * 100).toFixed(1) : '0.0';
            return { ...data, totalDays: workingDays, percentage };
        });

        const totalStudents = students.length;
        const totalAttendance = studentRows.reduce((sum, s) => sum + s.attended, 0);
        const maxPossible = totalStudents * workingDays;
        const classPercentage = maxPossible > 0 ? ((totalAttendance / maxPossible) * 100).toFixed(1) : '0.0';

        const classRows = [{ totalStudents, totalAttendance, classPercentage }];

        return { studentRows, classRows };
    }

    async function handleGenerateReport() {
        const selectedMonth = document.getElementById('reportMonth').value;
        if (!selectedMonth) { 
            document.querySelector('#individualReportTable tbody').innerHTML = '<tr><td colspan="6">No attendance data for any month.</td></tr>';
            document.querySelector('#classReportTable tbody').innerHTML = '<tr><td colspan="3">No data available.</td></tr>';
            return; 
        }
        
        const { studentRows, classRows } = await calculateReportData(selectedMonth);

        const sTbody = document.querySelector('#individualReportTable tbody');
        sTbody.innerHTML = studentRows.length > 0
            ? studentRows.map(r => `<tr><td>${r.roll}</td><td>${r.name}</td><td>${r.class}</td><td>${r.attended}</td><td>${r.totalDays}</td><td>${r.percentage}%</td></tr>`).join('')
            : '<tr><td colspan="6">No data for selected period.</td></tr>';

        const cTbody = document.querySelector('#classReportTable tbody');
        cTbody.innerHTML = classRows.map(c => `<tr><td>${c.totalStudents}</td><td>${c.totalAttendance}</td><td>${c.classPercentage}%</td></tr>`).join('');
    }

    async function handleExportIndividualCSV() {
        const selectedMonth = document.getElementById('reportMonth').value;
        const { studentRows } = await calculateReportData(selectedMonth);
        let csv = "Roll No.,Name,Class,Attended,Total Days,Percentage\n";
        studentRows.forEach(r => {
            csv += `"${r.roll}","${r.name}","${r.class}",${r.attended},${r.totalDays},"${r.percentage}%"\n`;
        });
        downloadFile(csv, `individual_report_${selectedMonth}.csv`, "text/csv;charset=utf-8;");
    }

    // ---------- Utility Functions ----------
    function speak(text) {
        try {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utter = new SpeechSynthesisUtterance(text);
                utter.lang = "en-US";
                window.speechSynthesis.speak(utter);
            }
        } catch (e) { console.error('Speech error', e); }
    }

    async function startCamera(videoId) {
        try {
            const videoEl = document.getElementById(videoId);
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            videoEl.srcObject = stream;
        } catch (err) {
            console.error("Camera error:", err);
            alert("Could not start camera. Please grant permission.");
        }
    }

    function captureImage(videoId) {
        const video = document.getElementById(videoId);
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg");
    }

    function downloadFile(data, filename, type) {
        const blob = new Blob([data], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    // --- Start the App ---
    initialize();
});