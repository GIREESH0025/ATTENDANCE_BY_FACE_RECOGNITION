document.addEventListener('DOMContentLoaded', () => {
    // ---------- Global State ----------
    let currentStream;

    // ---------- IndexedDB Setup and Helpers ----------
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

    function dbGet(storeName, key) {
        return new Promise(async (resolve, reject) => {
            const db = await dbPromise;
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = key ? store.get(key) : store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    function dbPut(storeName, data) {
        return new Promise(async (resolve, reject) => {
            const db = await dbPromise;
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(data);
            tx.oncomplete = () => resolve();
            tx.onerror = (event) => reject(event.target.error);
        });
    }
    
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

        document.querySelector('nav button').click();
    }
    
    // ---------- Camera Management ----------
    async function startCamera(videoId) {
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }
        try {
            const videoEl = document.getElementById(videoId);
            currentStream = await navigator.mediaDevices.getUserMedia({ video: true });
            videoEl.srcObject = currentStream;
            await videoEl.play();
        } catch (err) {
            console.error("Camera error:", err);
            alert("Could not start camera. Please ensure you have granted camera permission and are using localhost.");
        }
    }

    function stopCamera() {
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
            currentStream = null;
        }
    }

    function captureImage(videoId) {
        const video = document.getElementById(videoId);
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg");
    }

    // ---------- UI & Event Listeners ----------
    function setupTabNavigation() {
        document.querySelectorAll('nav button').forEach(btn => {
            btn.addEventListener('click', async () => {
                document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
                document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
                
                const tabId = btn.dataset.tab;
                document.getElementById(tabId).classList.remove('hidden');
                btn.classList.add('active');

                stopCamera();
                
                if (tabId === 'enroll') await startCamera('video');
                if (tabId === 'scan') await startCamera('scanVideo');

                if (tabId === 'reports') {
                    document.getElementById('workingDays').value = loadWorkingDays();
                    await populateMonthSelector();
                    await handleGenerateReport();
                }
            });
        });
    }
    
    function setStatus(elementId, message, type) {
        const el = document.getElementById(elementId);
        el.textContent = message;
        el.className = 'status-message';
        if (type) el.classList.add(type);
    }

    function speak(text) {
        try {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utter = new SpeechSynthesisUtterance(text);
                window.speechSynthesis.speak(utter);
            }
        } catch (e) { console.error('Speech synthesis error', e); }
    }

    function setupEnrollment() {
        document.getElementById('enrollBtn').addEventListener('click', handleEnroll);
    }

    async function handleEnroll() {
        const roll = document.getElementById('studentRoll').value.trim();
        const name = document.getElementById('studentName').value.trim();
        const sClass = document.getElementById('studentClass').value.trim();
        
        if (!roll || !name || !sClass) {
            alert("Please fill in all student details.");
            return;
        }

        setStatus('enrollStatus', "Processing...", 'info');
        const img = captureImage('video');

        try {
            const res = await fetch("/api/add_face", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ roll, image: img })
            });
            const data = await res.json();
            
            if (data.status === "success") {
                await saveStudent({ roll, name, class: sClass });
                setStatus('enrollStatus', `✅ ${data.message}`, 'success');
                speak("Student enrolled successfully.");
            } else {
                setStatus('enrollStatus', `❌ ${data.message}`, 'error');
                speak("Enrollment failed.");
            }
        } catch (error) {
            setStatus('enrollStatus', "❌ Error connecting to server.", 'error');
        }
    }

    function setupRecognition() {
        document.getElementById('scanBtn').addEventListener('click', handleScan);
    }
    
    async function handleScan() {
        setStatus('scanStatus', "Recognizing...", 'info');
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
                setStatus('scanStatus', `❌ ${data.message}`, 'error');
                speak("Recognition failed.");
            }
        } catch (error) {
            setStatus('scanStatus', "❌ Error connecting to server.", 'error');
        }
    }

    function setupManualAttendance() {
        document.getElementById('manualMarkBtn').addEventListener('click', handleManualMark);
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
        const today = new Date().toISOString().split('T')[0];

        try {
            const student = await dbGet(STORE_STUDENTS, roll);
            if (!student) {
                setStatus(statusElId, `❌ Roll "${roll}" not found. Please enroll.`, 'error');
                speak("Student not enrolled.");
                return;
            }

            const allAttendance = await loadAttendance();
            const alreadyMarked = allAttendance.find(r => r.roll === roll && r.date === today);

            if (alreadyMarked) {
                setStatus(statusElId, `⚠️ Attendance already marked for ${student.name}.`, 'warning');
                speak(`Attendance already marked for ${student.name}.`);
            } else {
                await saveAttendanceRecord({
                    roll: student.roll,
                    name: student.name,
                    class: student.class,
                    time: new Date().toLocaleTimeString(),
                    date: today
                });
                setStatus(statusElId, `✅ Attendance marked for ${student.name}.`, 'success');
                speak(`Attendance marked for ${student.name}.`);
            }
        } catch (error) {
            setStatus(statusElId, "❌ A database error occurred.", 'error');
        }
    }
    
    // ---------- Reports Section ----------
    function setupReports() {
        document.getElementById('generateReportBtn').addEventListener('click', handleGenerateReport);
        document.getElementById('exportIndividualCsvBtn').addEventListener('click', handleExportIndividualCSV);
    }

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
        const workingDays = parseInt(document.getElementById('workingDays').value) || 22;
        saveWorkingDays(workingDays);

        const studentAttendanceDays = new Map();
        students.forEach(s => studentAttendanceDays.set(s.roll, new Set()));
        
        attendance.forEach(r => {
            if (studentAttendanceDays.has(r.roll)) {
                studentAttendanceDays.get(r.roll).add(r.date);
            }
        });
        
        const studentRows = students.map(s => {
            const attended = studentAttendanceDays.get(s.roll)?.size || 0;
            const percentage = workingDays > 0 ? ((attended / workingDays) * 100).toFixed(1) : '0.0';
            return { ...s, attended, totalDays: workingDays, percentage };
        }).sort((a, b) => a.roll.localeCompare(b.roll, undefined, { numeric: true }));

        const totalStudents = students.length;
        const totalAttendance = studentRows.reduce((sum, s) => sum + s.attended, 0);
        const maxPossible = totalStudents * workingDays;
        const classPercentage = maxPossible > 0 ? ((totalAttendance / maxPossible) * 100).toFixed(1) : '0.0';
        const classRows = [{ totalStudents, totalAttendance, classPercentage }];

        return { studentRows, classRows };
    }

    async function handleGenerateReport() {
        const selectedMonth = document.getElementById('reportMonth').value;
        if (!selectedMonth) return; 
        
        const { studentRows, classRows } = await calculateReportData(selectedMonth);

        const sTbody = document.querySelector('#individualReportTable tbody');
        sTbody.innerHTML = studentRows.length > 0
            ? studentRows.map(r => `<tr><td>${r.roll}</td><td>${r.name}</td><td>${r.class}</td><td>${r.attended}</td><td>${r.totalDays}</td><td>${r.percentage}%</td></tr>`).join('')
            : '<tr><td colspan="6">No data for selected period.</td></tr>';

        const cTbody = document.querySelector('#classReportTable tbody');
        cTbody.innerHTML = classRows.map(c => `<tr><td>${c.totalStudents}</td><td>${c.totalAttendance}</td><td>${c.classPercentage}%</td></tr>`).join('');
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

    async function handleExportIndividualCSV() {
        const selectedMonth = document.getElementById('reportMonth').value;
        const { studentRows } = await calculateReportData(selectedMonth);
        let csv = "Roll No.,Name,Class,Attended,Total Days,Percentage\n";
        studentRows.forEach(r => {
            csv += `"${r.roll}","${r.name}","${r.class}",${r.attended},${r.totalDays},"${r.percentage}%"\n`;
        });
        downloadFile(csv, `student_report_${selectedMonth}.csv`, "text/csv;charset=utf-8;");
    }
    
    // --- Start the App ---
    initialize();
});
