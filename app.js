/**
 * Parapendio Ae.C.I. Exam Quiz & Spaced Repetition System
 * Total Questions: 504 across 9 subjects
 */

// ---------------- STATE & STORAGE ---------------- //
const STORAGE_KEY = 'vds_parapendio_state_v1';

let appState = {
  currentView: 'smart-study',
  soundEnabled: true,
  theme: 'dark',
  streak: 0,
  bestStreak: 0,
  totalAnswered: 0,
  totalCorrect: 0,
  userStats: {}, // qid -> { seen: int, correct: int, wrong: int, streak: int, starred: bool, lastSeen: timestamp }
  mistakeIds: [], // array of qids currently in mistake drill
};

// Exam state
let examState = {
  active: false,
  questions: [], // 30 selected questions
  currentIdx: 0,
  answers: {}, // qid -> chosen option index (1, 2, 3)
  timeLeft: 30 * 60, // 30 minutes
  timerInterval: null
};

// Subject view state
let subjectState = {
  subjectId: 1,
  questions: [],
  currentIdx: 0,
  answered: false
};

// Mistakes view state
let mistakeViewState = {
  currentQ: null,
  answered: false
};

// Smart Study current question
let currentStudyQ = null;
let studyAnswered = false;

// ---------------- AUDIO (Web Audio API) ---------------- //
let audioCtx = null;
function playSound(type) {
  if (!appState.soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === 'correct') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'wrong') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(146.83, now + 0.2);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (e) {
    console.warn('Audio not allowed yet or error:', e);
  }
}

// ---------------- INIT & PERSISTENCE ---------------- //
function loadSavedState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      appState = { ...appState, ...parsed };
    }
  } catch (e) {
    console.error('Error loading saved state:', e);
  }

  // Ensure every question has an entry in userStats
  QUIZ_DATA.forEach(q => {
    if (!appState.userStats[q.id]) {
      appState.userStats[q.id] = {
        seen: 0,
        correct: 0,
        wrong: 0,
        streak: 0,
        starred: false,
        lastSeen: 0
      };
    }
  });

  // Apply theme
  document.documentElement.setAttribute('data-theme', appState.theme);
  updateThemeButton();
  updateSoundButton();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    updateHeaderStats();
  } catch (e) {
    console.error('Error saving state:', e);
  }
}

// ---------------- VIEW ROUTING ---------------- //
function switchView(viewName) {
  appState.currentView = viewName;
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('data-view') === viewName);
  });
  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.remove('active');
  });

  const activeSection = document.getElementById(`view-${viewName}`);
  if (activeSection) {
    activeSection.classList.add('active');
  }

  if (viewName === 'smart-study') {
    if (!currentStudyQ || studyAnswered) loadNextStudyQuestion();
  } else if (viewName === 'subject-mode') {
    loadSubjectQuestions();
  } else if (viewName === 'mistakes-mode') {
    loadMistakeQuestion();
  } else if (viewName === 'catalog-mode') {
    renderCatalog();
  } else if (viewName === 'stats-mode') {
    renderStatsDashboard();
  }
}

// ---------------- SPACED REPETITION ENGINE ---------------- //
/**
 * Calculates dynamic priority score for a question:
 * - Never seen: 150
 * - Streak == 0 (recent mistake): 300
 * - Streak == 1: 120
 * - Streak == 2: 60
 * - Streak >= 3: 20
 * - Starred questions get +80 boost
 * - Time factor adds weight over time
 */
function getQuestionWeight(q) {
  const stats = appState.userStats[q.id];
  if (!stats || stats.seen === 0) return 150;
  
  let base = 100;
  if (stats.streak === 0) {
    base = 300 + (stats.wrong * 20);
  } else if (stats.streak === 1) {
    base = 120;
  } else if (stats.streak === 2) {
    base = 60;
  } else {
    base = 20;
  }

  if (stats.starred) base += 80;

  // Time decay: 5% more priority per hour since last seen
  const hoursSince = (Date.now() - (stats.lastSeen || 0)) / (1000 * 60 * 60);
  const timeBonus = Math.min(100, Math.floor(hoursSince * 5));

  return base + timeBonus;
}

function selectNextSmartQuestion() {
  // Compute weighted random
  let totalWeight = 0;
  const weights = QUIZ_DATA.map(q => {
    // Avoid repeating immediately the exact same question if >1 questions exist
    const w = (currentStudyQ && q.id === currentStudyQ.id && QUIZ_DATA.length > 1) ? 0 : getQuestionWeight(q);
    totalWeight += w;
    return w;
  });

  let rnd = Math.random() * totalWeight;
  for (let i = 0; i < QUIZ_DATA.length; i++) {
    rnd -= weights[i];
    if (rnd <= 0) {
      return QUIZ_DATA[i];
    }
  }
  return QUIZ_DATA[0];
}

function loadNextStudyQuestion() {
  currentStudyQ = selectNextSmartQuestion();
  studyAnswered = false;

  const stats = appState.userStats[currentStudyQ.id];
  document.getElementById('study-subject').innerText = currentStudyQ.subject;
  document.getElementById('study-qid').innerText = `#${currentStudyQ.id}`;
  document.getElementById('study-repetitions').innerText = `Ripetizioni: ${stats.seen}`;
  
  let priorityLabel = 'Priorità: Normale';
  if (stats.seen === 0) priorityLabel = '⚪ Nuova Domanda';
  else if (stats.streak === 0) priorityLabel = '❌ Da Recuperare (Priorità Alta)';
  else if (stats.streak >= 3) priorityLabel = '✅ Memorizzata';
  document.getElementById('study-priority-badge').innerText = priorityLabel;

  // Star button state
  const starBtn = document.getElementById('study-star-btn');
  starBtn.innerText = stats.starred ? '⭐ Difficile (Attivo)' : '⭐ Difficile';
  starBtn.style.color = stats.starred ? '#fbbf24' : 'inherit';

  // Question & options
  document.getElementById('study-question-text').innerText = currentStudyQ.question;
  const optionsContainer = document.getElementById('study-options-container');
  optionsContainer.innerHTML = '';

  currentStudyQ.options.forEach((optText, index) => {
    const optNum = index + 1;
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.setAttribute('data-index', optNum);
    btn.innerHTML = `
      <div class="option-key">${optNum}</div>
      <div class="option-content">${optText}</div>
      <div class="option-status-icon"></div>
    `;
    btn.addEventListener('click', () => handleStudyAnswer(optNum));
    optionsContainer.appendChild(btn);
  });

  // Hide feedback & next button
  const feedbackBanner = document.getElementById('study-feedback-banner');
  feedbackBanner.style.display = 'none';
  feedbackBanner.className = 'feedback-banner';
  document.getElementById('study-next-btn').style.display = 'none';
}

function handleStudyAnswer(chosenIndex) {
  if (studyAnswered) return;
  studyAnswered = true;

  const correct = chosenIndex === currentStudyQ.correct_answer;
  const stats = appState.userStats[currentStudyQ.id];
  stats.seen++;
  stats.lastSeen = Date.now();
  appState.totalAnswered++;

  const optionButtons = document.querySelectorAll('#study-options-container .option-btn');
  optionButtons.forEach(btn => {
    btn.classList.add('disabled');
    const idx = parseInt(btn.getAttribute('data-index'));
    if (idx === currentStudyQ.correct_answer) {
      if (correct) {
        btn.classList.add('selected-correct');
        btn.querySelector('.option-status-icon').innerText = '✅';
      } else {
        btn.classList.add('revealed-correct');
        btn.querySelector('.option-status-icon').innerText = '✅';
      }
    } else if (idx === chosenIndex && !correct) {
      btn.classList.add('selected-wrong');
      btn.querySelector('.option-status-icon').innerText = '❌';
    }
  });

  const banner = document.getElementById('study-feedback-banner');
  const icon = document.getElementById('study-feedback-icon');
  const text = document.getElementById('study-feedback-text');

  if (correct) {
    stats.correct++;
    stats.streak++;
    appState.streak++;
    appState.totalCorrect++;
    if (appState.streak > appState.bestStreak) appState.bestStreak = appState.streak;

    // If it was in mistakes and answered right twice, remove from mistakes list
    if (stats.streak >= 2) {
      appState.mistakeIds = appState.mistakeIds.filter(id => id !== currentStudyQ.id);
    }

    playSound('correct');
    banner.className = 'feedback-banner correct';
    icon.innerText = '🎉';
    text.innerHTML = `<strong>Risposta Esatta!</strong> Serie attuale: ${appState.streak} di fila. Questa domanda riapparirà più avanti per consolidarla.`;
  } else {
    stats.wrong++;
    stats.streak = 0;
    appState.streak = 0;

    if (!appState.mistakeIds.includes(currentStudyQ.id)) {
      appState.mistakeIds.push(currentStudyQ.id);
    }

    playSound('wrong');
    banner.className = 'feedback-banner wrong';
    icon.innerText = '❌';
    text.innerHTML = `<strong>Risposta Errata!</strong> La risposta corretta è la <strong>N° ${currentStudyQ.correct_answer}</strong>. Domanda salvata per il ripasso immediato.`;
  }

  banner.style.display = 'flex';
  document.getElementById('study-next-btn').style.display = 'inline-flex';
  saveState();
}

// ---------------- EXAM SIMULATION ENGINE ---------------- //
// Official distribution for 30 questions
const EXAM_QUOTAS = {
  1: 3, // Normativa
  2: 9, // Aerodinamica
  3: 1, // Pronto Soccorso
  4: 1, // Fisiopatologia
  5: 7, // Meteorologia
  6: 1, // Strumenti
  7: 5, // Tecnica di Pilotaggio
  8: 1, // Materiali
  9: 2  // Sicurezza del Volo
};

function generateExamQuestions() {
  const selected = [];
  for (let sId = 1; sId <= 9; sId++) {
    const pool = QUIZ_DATA.filter(q => q.subject_id === sId);
    const quota = EXAM_QUOTAS[sId];
    // Shuffle pool
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    selected.push(...shuffled.slice(0, quota));
  }
  // Shuffle final 30 questions
  return selected.sort(() => Math.random() - 0.5);
}

function startExam() {
  examState.questions = generateExamQuestions();
  examState.currentIdx = 0;
  examState.answers = {};
  examState.timeLeft = 30 * 60; // 30 minutes
  examState.active = true;

  document.getElementById('exam-intro').style.display = 'none';
  document.getElementById('exam-result').style.display = 'none';
  document.getElementById('exam-active').style.display = 'block';

  // Setup timer
  clearInterval(examState.timerInterval);
  examState.timerInterval = setInterval(() => {
    examState.timeLeft--;
    updateExamTimerDisplay();
    if (examState.timeLeft <= 0) {
      clearInterval(examState.timerInterval);
      finishExam();
    }
  }, 1000);
  updateExamTimerDisplay();

  renderExamQuestion();
  renderExamNavDots();
}

function updateExamTimerDisplay() {
  const m = Math.floor(examState.timeLeft / 60);
  const s = examState.timeLeft % 60;
  document.getElementById('exam-timer-display').innerText = 
    `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function renderExamNavDots() {
  const container = document.getElementById('exam-nav-dots');
  container.innerHTML = '';
  examState.questions.forEach((q, idx) => {
    const dot = document.createElement('div');
    dot.className = 'exam-nav-dot';
    if (idx === examState.currentIdx) dot.classList.add('current');
    if (examState.answers[q.id] !== undefined) dot.classList.add('answered');
    dot.innerText = idx + 1;
    dot.addEventListener('click', () => {
      examState.currentIdx = idx;
      renderExamQuestion();
      renderExamNavDots();
    });
    container.appendChild(dot);
  });
}

function renderExamQuestion() {
  const q = examState.questions[examState.currentIdx];
  document.getElementById('exam-current-idx').innerText = examState.currentIdx + 1;
  document.getElementById('exam-subject').innerText = q.subject;
  document.getElementById('exam-qid').innerText = `#${q.id}`;
  document.getElementById('exam-question-text').innerText = q.question;

  const container = document.getElementById('exam-options-container');
  container.innerHTML = '';

  const chosen = examState.answers[q.id];

  q.options.forEach((optText, index) => {
    const optNum = index + 1;
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    if (chosen === optNum) {
      btn.style.borderColor = 'var(--accent)';
      btn.style.background = 'rgba(56, 189, 248, 0.15)';
    }
    btn.innerHTML = `
      <div class="option-key" style="${chosen === optNum ? 'background: var(--accent); color: #000;' : ''}">${optNum}</div>
      <div class="option-content">${optText}</div>
    `;
    btn.addEventListener('click', () => {
      examState.answers[q.id] = optNum;
      renderExamQuestion();
      renderExamNavDots();
    });
    container.appendChild(btn);
  });

  // Nav buttons state
  document.getElementById('exam-prev-btn').disabled = examState.currentIdx === 0;
  document.getElementById('exam-next-btn').innerText = 
    examState.currentIdx === examState.questions.length - 1 ? 'Riepilogo Esame 🏁' : 'Successiva ➡️';
}

function finishExam() {
  clearInterval(examState.timerInterval);
  examState.active = false;

  let correctCount = 0;
  let errorCount = 0;
  let unansweredCount = 0;

  const resultsBreakdown = [];

  examState.questions.forEach((q, idx) => {
    const chosen = examState.answers[q.id];
    const isCorrect = chosen === q.correct_answer;
    
    // Update global question stats
    const stats = appState.userStats[q.id];
    if (chosen !== undefined) {
      stats.seen++;
      stats.lastSeen = Date.now();
      appState.totalAnswered++;
      if (isCorrect) {
        correctCount++;
        stats.correct++;
        stats.streak++;
        appState.totalCorrect++;
      } else {
        errorCount++;
        stats.wrong++;
        stats.streak = 0;
        if (!appState.mistakeIds.includes(q.id)) appState.mistakeIds.push(q.id);
      }
    } else {
      unansweredCount++;
      errorCount++;
      stats.wrong++;
      stats.streak = 0;
      if (!appState.mistakeIds.includes(q.id)) appState.mistakeIds.push(q.id);
    }

    resultsBreakdown.push({
      num: idx + 1,
      q,
      chosen,
      isCorrect
    });
  });

  saveState();

  const isPassed = errorCount <= 3; // Max 3 errors allowed by AeCI

  document.getElementById('exam-active').style.display = 'none';
  const resContainer = document.getElementById('exam-result');
  resContainer.style.display = 'block';

  let breakdownHTML = resultsBreakdown.map(item => `
    <div style="padding: 12px; margin-bottom: 10px; border-radius: 8px; border: 1px solid ${item.isCorrect ? 'var(--success-border)' : 'var(--danger-border)'}; background: ${item.isCorrect ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)'};">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between;">
        <span>#${item.num} [${item.q.subject} - #${item.q.id}]</span>
        <span>${item.isCorrect ? '✅ Esatta' : (item.chosen ? '❌ Errata' : '⚠️ Non risposta')}</span>
      </div>
      <div style="font-size: 14px; margin-bottom: 8px;">${item.q.question}</div>
      <div style="font-size: 13px; color: var(--text-muted);">
        Tua risposta: <strong>${item.chosen ? item.q.options[item.chosen - 1] : 'Nessuna'}</strong><br>
        Risposta corretta: <strong style="color: #4ade80;">${item.q.options[item.q.correct_answer - 1]}</strong>
      </div>
    </div>
  `).join('');

  resContainer.innerHTML = `
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="font-size: 54px; margin-bottom: 10px;">${isPassed ? '🏆' : '⚠️'}</div>
      <h2 style="font-size: 26px; color: ${isPassed ? '#4ade80' : '#f87171'}; margin-bottom: 6px;">
        ${isPassed ? 'ESAME SUPERATO! (IDONEO)' : 'ESAME NON SUPERATO (NON IDONEO)'}
      </h2>
      <p style="font-size: 15px; color: var(--text-muted);">
        Risposte Esatte: <strong>${correctCount} / 30</strong> • Errori: <strong>${errorCount}</strong> (Massimo consentito: 3)
      </p>
    </div>

    <div style="display: flex; gap: 10px; justify-content: center; margin-bottom: 30px;">
      <button class="btn-primary" onclick="startExam()">🔄 Nuova Simulazione</button>
      <button class="btn-secondary" onclick="switchView('mistakes-mode')">❌ Ripassa gli Errori (${appState.mistakeIds.length})</button>
      <button class="btn-secondary" onclick="switchView('smart-study')">🧠 Torna allo Studio</button>
    </div>

    <h3 style="margin-bottom: 14px; font-size: 17px;">Dettaglio Correzione Domande</h3>
    <div style="max-height: 500px; overflow-y: auto; padding-right: 6px;">
      ${breakdownHTML}
    </div>
  `;
}

// ---------------- SUBJECT STUDY VIEW ---------------- //
function loadSubjectQuestions() {
  const sId = parseInt(document.getElementById('subject-select').value);
  subjectState.subjectId = sId;
  subjectState.questions = QUIZ_DATA.filter(q => q.subject_id === sId);
  subjectState.currentIdx = 0;
  renderSubjectQuestion();
}

function renderSubjectQuestion() {
  const q = subjectState.questions[subjectState.currentIdx];
  subjectState.answered = false;

  document.getElementById('subview-subject').innerText = q.subject;
  document.getElementById('subview-qid').innerText = `#${q.id}`;
  document.getElementById('subview-counter').innerText = 
    `${subjectState.currentIdx + 1} di ${subjectState.questions.length}`;

  const masteredCount = subjectState.questions.filter(item => (appState.userStats[item.id]?.streak || 0) >= 2).length;
  document.getElementById('subject-mode-progress').innerText = 
    `${masteredCount} / ${subjectState.questions.length} memorizzate`;

  document.getElementById('subview-question-text').innerText = q.question;

  const container = document.getElementById('subview-options-container');
  container.innerHTML = '';

  q.options.forEach((optText, index) => {
    const optNum = index + 1;
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.setAttribute('data-index', optNum);
    btn.innerHTML = `
      <div class="option-key">${optNum}</div>
      <div class="option-content">${optText}</div>
      <div class="option-status-icon"></div>
    `;
    btn.addEventListener('click', () => handleSubjectAnswer(optNum));
    optionsContainer_append(container, btn);
  });

  const banner = document.getElementById('subview-feedback-banner');
  banner.style.display = 'none';
  banner.className = 'feedback-banner';

  document.getElementById('subview-prev-btn').disabled = subjectState.currentIdx === 0;
}

function optionsContainer_append(container, btn) {
  container.appendChild(btn);
}

function handleSubjectAnswer(chosenIndex) {
  if (subjectState.answered) return;
  subjectState.answered = true;

  const q = subjectState.questions[subjectState.currentIdx];
  const correct = chosenIndex === q.correct_answer;
  const stats = appState.userStats[q.id];
  stats.seen++;
  stats.lastSeen = Date.now();
  appState.totalAnswered++;

  const optionButtons = document.querySelectorAll('#subview-options-container .option-btn');
  optionButtons.forEach(btn => {
    btn.classList.add('disabled');
    const idx = parseInt(btn.getAttribute('data-index'));
    if (idx === q.correct_answer) {
      btn.classList.add(correct ? 'selected-correct' : 'revealed-correct');
      btn.querySelector('.option-status-icon').innerText = '✅';
    } else if (idx === chosenIndex && !correct) {
      btn.classList.add('selected-wrong');
      btn.querySelector('.option-status-icon').innerText = '❌';
    }
  });

  const banner = document.getElementById('subview-feedback-banner');
  const icon = document.getElementById('subview-feedback-icon');
  const text = document.getElementById('subview-feedback-text');

  if (correct) {
    stats.correct++;
    stats.streak++;
    appState.streak++;
    appState.totalCorrect++;
    playSound('correct');
    banner.className = 'feedback-banner correct';
    icon.innerText = '🎉';
    text.innerHTML = `<strong>Risposta Esatta!</strong>`;
  } else {
    stats.wrong++;
    stats.streak = 0;
    appState.streak = 0;
    if (!appState.mistakeIds.includes(q.id)) appState.mistakeIds.push(q.id);
    playSound('wrong');
    banner.className = 'feedback-banner wrong';
    icon.innerText = '❌';
    text.innerHTML = `<strong>Risposta Errata!</strong> Quella corretta è la N° <strong>${q.correct_answer}</strong>.`;
  }

  banner.style.display = 'flex';
  saveState();
}

// ---------------- MISTAKES DRILL VIEW ---------------- //
function loadMistakeQuestion() {
  const noMistakesBox = document.getElementById('no-mistakes-box');
  const activeBox = document.getElementById('active-mistakes-box');

  if (appState.mistakeIds.length === 0) {
    noMistakesBox.style.display = 'block';
    activeBox.style.display = 'none';
    return;
  }

  noMistakesBox.style.display = 'none';
  activeBox.style.display = 'block';
  document.getElementById('mistakes-current-count').innerText = appState.mistakeIds.length;

  const nextId = appState.mistakeIds[0];
  mistakeViewState.currentQ = QUIZ_DATA.find(q => q.id === nextId);
  mistakeViewState.answered = false;

  const q = mistakeViewState.currentQ;
  const stats = appState.userStats[q.id];

  document.getElementById('mistake-subject').innerText = q.subject;
  document.getElementById('mistake-qid').innerText = `#${q.id}`;
  document.getElementById('mistake-times-wrong').innerText = `Errori accumulati: ${stats.wrong}`;
  document.getElementById('mistake-question-text').innerText = q.question;

  const container = document.getElementById('mistake-options-container');
  container.innerHTML = '';

  q.options.forEach((optText, index) => {
    const optNum = index + 1;
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.setAttribute('data-index', optNum);
    btn.innerHTML = `
      <div class="option-key">${optNum}</div>
      <div class="option-content">${optText}</div>
      <div class="option-status-icon"></div>
    `;
    btn.addEventListener('click', () => handleMistakeAnswer(optNum));
    container.appendChild(btn);
  });

  const banner = document.getElementById('mistake-feedback-banner');
  banner.style.display = 'none';
  banner.className = 'feedback-banner';
  document.getElementById('mistake-next-btn').style.display = 'none';
}

function handleMistakeAnswer(chosenIndex) {
  if (mistakeViewState.answered) return;
  mistakeViewState.answered = true;

  const q = mistakeViewState.currentQ;
  const correct = chosenIndex === q.correct_answer;
  const stats = appState.userStats[q.id];
  stats.seen++;
  stats.lastSeen = Date.now();
  appState.totalAnswered++;

  const optionButtons = document.querySelectorAll('#mistake-options-container .option-btn');
  optionButtons.forEach(btn => {
    btn.classList.add('disabled');
    const idx = parseInt(btn.getAttribute('data-index'));
    if (idx === q.correct_answer) {
      btn.classList.add(correct ? 'selected-correct' : 'revealed-correct');
      btn.querySelector('.option-status-icon').innerText = '✅';
    } else if (idx === chosenIndex && !correct) {
      btn.classList.add('selected-wrong');
      btn.querySelector('.option-status-icon').innerText = '❌';
    }
  });

  const banner = document.getElementById('mistake-feedback-banner');
  const icon = document.getElementById('mistake-feedback-icon');
  const text = document.getElementById('mistake-feedback-text');

  if (correct) {
    stats.correct++;
    stats.streak++;
    appState.totalCorrect++;
    playSound('correct');

    // Remove from mistakes list immediately upon correct answer in drill mode
    appState.mistakeIds.shift();

    banner.className = 'feedback-banner correct';
    icon.innerText = '🎉';
    text.innerHTML = `<strong>Ottimo recupero!</strong> Domanda rimossa dall'elenco errori correnti.`;
  } else {
    stats.wrong++;
    stats.streak = 0;
    playSound('wrong');
    // Rotate to end of queue
    const failedId = appState.mistakeIds.shift();
    appState.mistakeIds.push(failedId);

    banner.className = 'feedback-banner wrong';
    icon.innerText = '❌';
    text.innerHTML = `<strong>Ancora errata!</strong> Risposta esatta: N° <strong>${q.correct_answer}</strong>. La domanda rimane in coda per essere riesaminata.`;
  }

  banner.style.display = 'flex';
  document.getElementById('mistake-next-btn').style.display = 'inline-flex';
  saveState();
}

// ---------------- CATALOG & SEARCH VIEW ---------------- //
function renderCatalog() {
  const searchTerm = (document.getElementById('catalog-search').value || '').toLowerCase().trim();
  const subjectFilter = document.getElementById('catalog-subject-filter').value;
  const statusFilter = document.getElementById('catalog-status-filter').value;

  const filtered = QUIZ_DATA.filter(q => {
    if (subjectFilter !== 'all' && q.subject_id !== parseInt(subjectFilter)) return false;
    
    const stats = appState.userStats[q.id] || { seen: 0, streak: 0, wrong: 0 };
    if (statusFilter === 'mastered' && stats.streak < 2) return false;
    if (statusFilter === 'learning' && (stats.seen === 0 || stats.streak >= 2)) return false;
    if (statusFilter === 'unseen' && stats.seen > 0) return false;
    if (statusFilter === 'mistakes' && stats.wrong === 0) return false;

    if (searchTerm) {
      const matchId = q.id.toString().includes(searchTerm);
      const matchQ = q.question.toLowerCase().includes(searchTerm);
      const matchOpt = q.options.some(opt => opt.toLowerCase().includes(searchTerm));
      if (!matchId && !matchQ && !matchOpt) return false;
    }

    return true;
  });

  document.getElementById('catalog-count').innerText = filtered.length;
  const container = document.getElementById('catalog-items-container');
  container.innerHTML = '';

  filtered.slice(0, 100).forEach(q => {
    const stats = appState.userStats[q.id];
    const item = document.createElement('div');
    item.className = 'catalog-item';
    item.innerHTML = `
      <div class="catalog-item-header">
        <span><strong>${q.subject}</strong> (ID: #${q.id})</span>
        <span>Viste: ${stats.seen} • Esatte: ${stats.correct} • Errori: ${stats.wrong}</span>
      </div>
      <div class="catalog-q-text">${q.question}</div>
      <div class="catalog-options">
        ${q.options.map((opt, i) => `
          <div class="catalog-opt ${i + 1 === q.correct_answer ? 'correct' : ''}">
            <strong>${i + 1}.</strong> ${opt} ${i + 1 === q.correct_answer ? ' ✔️' : ''}
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(item);
  });

  if (filtered.length > 100) {
    const notice = document.createElement('div');
    notice.style.textAlign = 'center';
    notice.style.padding = '15px';
    notice.style.color = 'var(--text-muted)';
    notice.innerText = `...e altre ${filtered.length - 100} domande. Usa la ricerca per restringere il campo.`;
    container.appendChild(notice);
  }
}

// ---------------- STATS DASHBOARD ---------------- //
function renderStatsDashboard() {
  const totalQ = QUIZ_DATA.length;
  let seenCount = 0;
  let masteredCount = 0;

  QUIZ_DATA.forEach(q => {
    const stats = appState.userStats[q.id];
    if (stats.seen > 0) seenCount++;
    if (stats.streak >= 2) masteredCount++;
  });

  const masteryPercent = Math.round((masteredCount / totalQ) * 100);
  const accuracy = appState.totalAnswered > 0 ? Math.round((appState.totalCorrect / appState.totalAnswered) * 100) : 0;

  document.getElementById('stats-mastery').innerText = `${masteryPercent}%`;
  document.getElementById('stats-seen').innerHTML = `${seenCount} <span style="font-size: 15px; color: var(--text-muted);">/ ${totalQ}</span>`;
  document.getElementById('stats-unseen-sub').innerText = `${totalQ - seenCount} ancora da vedere`;
  document.getElementById('stats-total-answers').innerText = appState.totalAnswered;
  document.getElementById('stats-accuracy').innerText = `Precisione globale: ${accuracy}%`;
  document.getElementById('stats-best-streak').innerText = appState.bestStreak;

  // Breakdown by subject
  const subjectsList = document.getElementById('stats-subjects-list');
  subjectsList.innerHTML = '';

  const subjectNames = [
    '1. Normativa e Legislazione',
    '2. Aerodinamica',
    '3. Pronto Soccorso',
    '4. Fisiopatologia del Volo',
    '5. Meteorologia e Aerologia',
    '6. Strumenti',
    '7. Tecnica di Pilotaggio',
    '8. Materiali',
    '9. Sicurezza del Volo'
  ];

  for (let sId = 1; sId <= 9; sId++) {
    const sQuestions = QUIZ_DATA.filter(q => q.subject_id === sId);
    const sTotal = sQuestions.length;
    const sMastered = sQuestions.filter(q => (appState.userStats[q.id]?.streak || 0) >= 2).length;
    const sPercent = Math.round((sMastered / sTotal) * 100);

    const row = document.createElement('div');
    row.className = 'subject-stat-row';
    row.innerHTML = `
      <div class="subject-stat-info">
        <span>${subjectNames[sId - 1]}</span>
        <span>${sMastered} / ${sTotal} (${sPercent}%)</span>
      </div>
      <div class="subject-stat-bar">
        <div class="subject-stat-fill" style="width: ${sPercent}%"></div>
      </div>
    `;
    subjectsList.appendChild(row);
  }
}

function updateHeaderStats() {
  const totalQ = QUIZ_DATA.length;
  let masteredCount = 0;
  QUIZ_DATA.forEach(q => {
    if ((appState.userStats[q.id]?.streak || 0) >= 2) masteredCount++;
  });
  const masteryPercent = Math.round((masteredCount / totalQ) * 100);

  document.getElementById('header-mastery').innerText = `${masteryPercent}%`;
  document.getElementById('header-streak').innerText = appState.streak;
  document.getElementById('header-errors').innerText = appState.mistakeIds.length;
  document.getElementById('mistake-tab-count').innerText = appState.mistakeIds.length;

  const fill = document.getElementById('study-progress-fill');
  if (fill) fill.style.width = `${masteryPercent}%`;
}

function updateThemeButton() {
  const btn = document.getElementById('theme-btn');
  btn.innerText = appState.theme === 'light' ? '☀️' : '🌙';
}

function updateSoundButton() {
  const btn = document.getElementById('sound-btn');
  btn.innerText = appState.soundEnabled ? '🔊' : '🔇';
}

// ---------------- EVENT LISTENERS ---------------- //
document.addEventListener('DOMContentLoaded', () => {
  loadSavedState();
  updateHeaderStats();

  // Navigation tab clicks
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchView(tab.getAttribute('data-view'));
    });
  });

  // Sound & Theme toggle
  document.getElementById('sound-btn').addEventListener('click', () => {
    appState.soundEnabled = !appState.soundEnabled;
    updateSoundButton();
    saveState();
  });

  document.getElementById('theme-btn').addEventListener('click', () => {
    appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', appState.theme);
    updateThemeButton();
    saveState();
  });

  // Smart Study buttons
  document.getElementById('study-next-btn').addEventListener('click', loadNextStudyQuestion);
  document.getElementById('study-star-btn').addEventListener('click', () => {
    if (!currentStudyQ) return;
    const stats = appState.userStats[currentStudyQ.id];
    stats.starred = !stats.starred;
    const starBtn = document.getElementById('study-star-btn');
    starBtn.innerText = stats.starred ? '⭐ Difficile (Attivo)' : '⭐ Difficile';
    starBtn.style.color = stats.starred ? '#fbbf24' : 'inherit';
    saveState();
  });

  // Exam buttons
  document.getElementById('start-exam-btn').addEventListener('click', startExam);
  document.getElementById('finish-exam-btn').addEventListener('click', () => {
    if (confirm('Sei sicuro di voler terminare l\'esame e vedere i risultati?')) {
      finishExam();
    }
  });
  document.getElementById('exam-prev-btn').addEventListener('click', () => {
    if (examState.currentIdx > 0) {
      examState.currentIdx--;
      renderExamQuestion();
      renderExamNavDots();
    }
  });
  document.getElementById('exam-next-btn').addEventListener('click', () => {
    if (examState.currentIdx < examState.questions.length - 1) {
      examState.currentIdx++;
      renderExamQuestion();
      renderExamNavDots();
    } else {
      if (confirm('Hai raggiunto l\'ultima domanda. Vuoi inviare l\'esame per la correzione?')) {
        finishExam();
      }
    }
  });

  // Subject view selectors
  document.getElementById('subject-select').addEventListener('change', loadSubjectQuestions);
  document.getElementById('subview-prev-btn').addEventListener('click', () => {
    if (subjectState.currentIdx > 0) {
      subjectState.currentIdx--;
      renderSubjectQuestion();
    }
  });
  document.getElementById('subview-next-btn').addEventListener('click', () => {
    if (subjectState.currentIdx < subjectState.questions.length - 1) {
      subjectState.currentIdx++;
      renderSubjectQuestion();
    }
  });

  // Mistake view buttons
  document.getElementById('mistake-next-btn').addEventListener('click', loadMistakeQuestion);
  document.getElementById('clear-mistakes-btn').addEventListener('click', () => {
    if (confirm('Vuoi azzerare la lista degli errori attivi?')) {
      appState.mistakeIds = [];
      saveState();
      loadMistakeQuestion();
    }
  });

  // Catalog search & filters
  document.getElementById('catalog-search').addEventListener('input', renderCatalog);
  document.getElementById('catalog-subject-filter').addEventListener('change', renderCatalog);
  document.getElementById('catalog-status-filter').addEventListener('change', renderCatalog);

  // Export / Import / Reset
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `parapendio_quiz_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        appState = { ...appState, ...imported };
        saveState();
        alert('Progressi importati con successo!');
        location.reload();
      } catch (err) {
        alert('File JSON non valido.');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('reset-stats-btn').addEventListener('click', () => {
    if (confirm('ATTENZIONE: Sei sicuro di voler azzerare tutti i progressi e le statistiche di studio?')) {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    }
  });

  // Global Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === '1' || e.key === '2' || e.key === '3') {
      const optNum = parseInt(e.key);
      if (appState.currentView === 'smart-study' && !studyAnswered) {
        handleStudyAnswer(optNum);
      } else if (appState.currentView === 'exam-mode' && examState.active) {
        const q = examState.questions[examState.currentIdx];
        examState.answers[q.id] = optNum;
        renderExamQuestion();
        renderExamNavDots();
      } else if (appState.currentView === 'subject-mode' && !subjectState.answered) {
        handleSubjectAnswer(optNum);
      } else if (appState.currentView === 'mistakes-mode' && !mistakeViewState.answered && mistakeViewState.currentQ) {
        handleMistakeAnswer(optNum);
      }
    } else if (e.key === ' ' || e.key === 'Enter') {
      if (appState.currentView === 'smart-study' && studyAnswered) {
        e.preventDefault();
        loadNextStudyQuestion();
      } else if (appState.currentView === 'mistakes-mode' && mistakeViewState.answered) {
        e.preventDefault();
        loadMistakeQuestion();
      }
    }
  });

  // Start with Smart Study view
  loadNextStudyQuestion();
});
