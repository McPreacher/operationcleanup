const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwakhpUYSNQZ4l4ZqYuTlLyI-xODo90zBYvpzqig7UC0YoHeo3DM5zAgqKigQH8fKDA8w/exec";

let familyData = [];
const defaultSchedule = { 0: "Rest & Prep", 1: "Bathrooms", 2: "Floors", 3: "Dusting", 4: "Kitchen", 5: "Laundry", 6: "Yard" };
let weeklySchedule = defaultSchedule;
let isSyncing = false;
let isSyncingFromAction = false; 
let syncTimeout = null; // Timer for the Silence Window

document.addEventListener('DOMContentLoaded', () => {
    // 1. Instant Load from Cache
    const cachedData = localStorage.getItem('familyCleanupCache');
    if (cachedData) {
        const parsed = JSON.parse(cachedData);
        familyData = parsed.familyData || [];
        weeklySchedule = parsed.weeklySchedule || defaultSchedule;
        renderApp();
        updateFocusBanner();
    }

    // 2. Initial Background Sync
    syncWithCloud();
    
    // 3. Regular background check every 15 seconds
    setInterval(syncWithCloud, 15000);
    setupGlobalListeners();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(() => console.log("Service Worker Registered"))
            .catch((err) => console.log("Service Worker Failed", err));
    }
});

// --- Cloud Sync Logic ---
async function syncWithCloud() {
    // BLOCK sync if: 
    // 1. We are already fetching
    // 2. We RECENTLY made a change (Silence Window)
    // 3. The user is currently typing
    if (isSyncing || isSyncingFromAction) return; 
    
    const activeElem = document.activeElement;
    if (activeElem && (activeElem.tagName === 'INPUT' || activeElem.getAttribute('contenteditable') === 'true')) {
        return; 
    }
    
    isSyncing = true;
    try {
        const response = await fetch(SCRIPT_URL);
        if (!response.ok) throw new Error('Network response was not ok');
        
        const cloudData = await response.json();
        processCloudData(cloudData);
        
        // Update Cache
        localStorage.setItem('familyCleanupCache', JSON.stringify({
            familyData,
            weeklySchedule
        }));

        updateFocusBanner();
        renderApp();
    } catch (e) {
        console.error("Background sync failed:", e);
    } finally {
        isSyncing = false;
    }
}

function processCloudData(data) {
    const newFamilyData = [];
    const rows = data.tasks || []; 
    
    rows.slice(1).forEach(row => {
        if (!row[0]) return;
        let person = newFamilyData.find(p => p.name === row[0]);
        if (!person) {
            person = { name: row[0], tasks: [], routine: [] };
            newFamilyData.push(person);
        }
        const category = row[3] || 'tasks';
        const isDone = (row[2] === true || row[2] === "TRUE" || row[2] === "true");
        person[category].push({ text: row[1], completed: isDone });
    });
    familyData = newFamilyData;
    
    if (data.schedule && data.schedule.length > 1) {
        data.schedule.slice(1).forEach(row => {
            weeklySchedule[row[0]] = row[1];
        });
    }
}

// --- UI Rendering ---
function renderApp() {
    const appContainer = document.getElementById('app-container');
    const maintenanceContainer = document.getElementById('maintenance-container');
    if (!appContainer || !maintenanceContainer) return;

    appContainer.innerHTML = '';
    maintenanceContainer.innerHTML = '';

    familyData.forEach((person, pIdx) => {
        appContainer.appendChild(createCard(person, pIdx, 'tasks', 'Cleanup Task'));
        maintenanceContainer.appendChild(createCard(person, pIdx, 'routine', 'Daily Chore'));
    });
    updateDashboard();
}

function createCard(person, pIdx, listKey, label) {
    const isComplete = person[listKey].length > 0 && person[listKey].every(t => t.completed);
    const card = document.createElement('div');
    card.id = `card-${listKey}-${pIdx}`;
    card.className = `person-card ${listKey === 'routine' ? 'routine-card' : ''} ${isComplete ? 'card-completed' : ''}`;
    
    card.innerHTML = `
        <div class="card-header">
            <h3>${person.name} <small>${label}s</small></h3>
            ${listKey === 'tasks' ? `<button onclick="deletePerson(${pIdx})" class="btn-delete-task">Remove User</button>` : ''}
        </div>
        <div class="task-list">
            ${person[listKey].map((task, tIdx) => `
                <div class="task-item">
                    <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTask(${pIdx}, ${tIdx}, '${listKey}')">
                    <span contenteditable="true" class="${task.completed ? 'done' : ''}" onblur="editTask(${pIdx}, ${tIdx}, this.innerText, '${listKey}')">${task.text}</span>
                    <button onclick="deleteTask(${pIdx}, ${tIdx}, '${listKey}')" class="btn-delete-task">×</button>
                </div>`).join('')}
        </div>
        <div class="add-task-row">
            <input type="text" placeholder="Add ${label}..." id="input-${listKey}-${pIdx}" 
                autocomplete="off" onkeypress="if(event.key === 'Enter') addTask(${pIdx}, '${listKey}')">
            <button onclick="addTask(${pIdx}, '${listKey}')">Add</button>
        </div>`;
    return card;
}

// --- Background Cloud Logic (No Loading Screen) ---
async function cloudPost(data) {
    // 1. Enter the Silence Window
    isSyncingFromAction = true;
    
    // Reset the 30-second timer every time a new action happens
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        isSyncingFromAction = false;
        console.log("Silence Window closed. Resuming background sync.");
    }, 30000); 

    try {
        // Send data silently
        await fetch(SCRIPT_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.error("Background update failed:", e);
    }
}

// --- Instant Actions ---
async function toggleTask(pIdx, tIdx, listKey) {
    const person = familyData[pIdx];
    const task = person[listKey][tIdx];
    
    // INSTANT UI update
    task.completed = !task.completed;
    if (task.completed && person[listKey].every(t => t.completed)) {
        triggerCelebration(pIdx, listKey);
    }
    renderApp(); 

    // Silent background sync
    await cloudPost({
        action: "updateTask",
        person: person.name,
        text: task.text,
        category: listKey,
        completed: task.completed
    });
}

async function addTask(pIdx, listKey) {
    const input = document.getElementById(`input-${listKey}-${pIdx}`);
    const person = familyData[pIdx];
    const text = input.value.trim();
    if (text) {
        // INSTANT UI update
        person[listKey].push({ text: text, completed: false });
        renderApp();
        input.value = ''; 
        
        // Silent background sync
        await cloudPost({ action: "addTask", person: person.name, text: text, category: listKey });
    }
}

async function deleteTask(pIdx, tIdx, listKey) {
    const person = familyData[pIdx];
    const task = person[listKey][tIdx];
    
    // INSTANT UI update
    person[listKey].splice(tIdx, 1);
    renderApp();
    
    // Silent background sync
    await cloudPost({ action: "deleteTask", person: person.name, text: task.text, category: listKey });
}

async function addPerson() {
    const nameInput = document.getElementById('person-name-input');
    const name = nameInput.value.trim();
    if (name) {
        // INSTANT UI update
        familyData.push({ name: name, tasks: [{text: "Welcome!", completed: false}], routine: [] });
        renderApp();
        closeModals();
        
        // Silent background sync
        await cloudPost({ action: "addPerson", person: name });
        nameInput.value = '';
    }
}

async function deletePerson(idx) {
    if(confirm(`Remove ${familyData[idx].name} and all their tasks?`)) {
        const name = familyData[idx].name;
        // INSTANT UI update
        familyData.splice(idx, 1);
        renderApp();
        
        // Silent background sync
        await cloudPost({ action: "deletePerson", person: name });
    }
}

async function resetWeek() {
    if(confirm("This will uncheck EVERY box for EVERYONE. Ready for the new week?")) {
        // INSTANT UI update
        familyData.forEach(p => {
            p.tasks.forEach(t => t.completed = false);
            p.routine.forEach(t => t.completed = false);
        });
        renderApp();
        
        // Silent background sync
        await cloudPost({ action: "resetCheckboxes" });
    }
}

async function editTask(pIdx, tIdx, newText, listKey) {
    const person = familyData[pIdx];
    const task = person[listKey][tIdx];
    if (task.text !== newText.trim()) {
        const oldText = task.text;
        const updatedText = newText.trim();
        
        // INSTANT UI update
        task.text = updatedText;
        renderApp();
        
        // Silent background sync
        await cloudPost({ action: "deleteTask", person: person.name, text: oldText, category: listKey });
        await cloudPost({ action: "addTask", person: person.name, text: updatedText, category: listKey });
    }
}

// --- UI Helpers ---
function triggerCelebration(pIdx, listKey) {
    if (typeof confetti === 'function') {
        confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
    setTimeout(() => {
        const card = document.getElementById(`card-${listKey}-${pIdx}`);
        if (card) {
            card.classList.add('celebrate-animation');
            setTimeout(() => card.classList.remove('celebrate-animation'), 1000);
        }
    }, 50);
}

function setupGlobalListeners() {
    const resetBtn = document.getElementById('reset-week-btn');
    if(resetBtn) resetBtn.onclick = resetWeek;

    const personInput = document.getElementById('person-name-input');
    if(personInput) {
        personInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addPerson(); });
    }
}

function updateFocusBanner() {
    const day = new Date().getDay();
    const banner = document.getElementById('current-focus');
    if (banner) {
        banner.innerText = weeklySchedule[day] || "General Cleaning";
    }
}

function openScheduleModal() {
    const container = document.getElementById('schedule-inputs-container');
    container.innerHTML = '';
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    days.forEach((day, i) => {
        container.innerHTML += `<div class="schedule-row"><label>${day}</label><input type="text" id="day-${i}" value="${weeklySchedule[i] || ''}"></div>`;
    });
    document.getElementById('schedule-modal').classList.remove('hidden');
}

async function saveWeeklySchedule() {
    const newSched = {};
    for (let i = 0; i < 7; i++) { 
        newSched[i] = document.getElementById(`day-${i}`).value; 
    }
    weeklySchedule = newSched;
    updateFocusBanner();
    closeModals();
    await cloudPost({ action: "saveSchedule", schedule: newSched });
}

function toggleSection(contentId, arrowId) {
    document.getElementById(contentId).classList.toggle('collapsed');
    document.getElementById(arrowId).classList.toggle('rotated');
}

function closeModals() { 
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); 
}

function updateDashboard() {
    let total = 0; 
    familyData.forEach(p => total += p.tasks.length);
    const pStat = document.getElementById('stat-people');
    const tStat = document.getElementById('stat-tasks');
    if (pStat) pStat.innerText = familyData.length;
    if (tStat) tStat.innerText = total;
}

const addPBtn = document.getElementById('add-person-btn');
if(addPBtn) addPBtn.onclick = () => {
    document.getElementById('modal').classList.remove('hidden');
    document.getElementById('person-name-input').focus();
};

const savePBtn = document.getElementById('save-person-btn');
if(savePBtn) savePBtn.onclick = addPerson;

window.onclick = (e) => { if (e.target.classList.contains('modal')) closeModals(); };