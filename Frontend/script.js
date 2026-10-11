
'use strict';

// ==================================================
// 1. CONFIGURATION
// ==================================================

const API = 'https://second-voice-ai.onrender.com';

const $ = (selector) => document.querySelector(selector);

const chat = $('#chat');
const input = $('#input');
const sendBtn = $('#send');
const micBtn = $('#mic');
const stopBtn = $('#stop');
const historyBox = $('#history');
const statusText = $('#status');
const statusDot = $('#dot');
const modeLabel = $('#mode');

let convs = {};
let cur = null;

let voice = false;
let busy = false;
let generation = 0;

let recorder = null;
let audioPlayer = null;
let abortController = null;
let toastTimer = null;

let isRecording = false;
let isStopping = false;
let voiceLoopPromise = null;

// Keep the complete transcript of the current voice session.
let voiceTranscript = [];

// ==================================================
// 2. INITIALIZE
// ==================================================

function newId() {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID();
    }

    return 'c-' + Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10);
}

cur = newId();

// ==================================================
// 3. STATUS AND NOTIFICATIONS
// ==================================================

function setStatus(message, state = '') {
    if (statusText) {
        statusText.textContent = message;
    }

    if (statusDot) {
        statusDot.className = state;
    }
}

function toast(message) {
    const element = $('#toast');

    if (!element) {
        console.error(message);
        return;
    }

    element.textContent = message;
    element.hidden = false;

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        element.hidden = true;
    }, 5000);
}

function formatTime(timestamp) {
    if (!timestamp) {
        return '';
    }

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
}

// ==================================================
// 4. HISTORY HELPERS
// ==================================================

function getUserMessage(entry) {
    return entry.user_message ??
        entry.user ??
        entry.message ??
        '';
}

function getAssistantReply(entry) {
    return entry.assistant_reply ??
        entry.assistant ??
        entry.reply ??
        '';
}

function getConversationId(entry) {
    return entry.conversation_id ??
        entry.conversationId ??
        '';
}

function getTimestamp(entry) {
    const timestamp = new Date(entry.timestamp || 0).getTime();

    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getSortedConversationIds() {
    return Object.keys(convs).sort((a, b) => {
        const entriesA = convs[a] || [];
        const entriesB = convs[b] || [];

        const latestA = entriesA.length
            ? getTimestamp(entriesA[entriesA.length - 1])
            : 0;

        const latestB = entriesB.length
            ? getTimestamp(entriesB[entriesB.length - 1])
            : 0;

        return latestB - latestA;
    });
}

// ==================================================
// 5. API HELPER
// ==================================================

async function api(url, options = {}) {
    let response;

    try {
        response = await fetch(url, options);
    } catch (error) {
        if (error.name === 'AbortError') {
            throw error;
        }

        throw new Error(
            `Cannot connect to the backend at ${API}. ` +
            'Please check whether FastAPI is running.'
        );
    }

    if (!response.ok) {
        let message = `Request failed: ${response.status}`;

        try {
            const data = await response.json();

            message = data.detail ??
                data.error ??
                data.message ??
                message;

            if (typeof message !== 'string') {
                message = JSON.stringify(message);
            }
        } catch {
            // Keep default error.
        }

        throw new Error(message);
    }

    return response;
}

// ==================================================
// 6. LOAD CHAT HISTORY
// ==================================================

async function loadHistory() {
    const response = await api(`${API}/api/history`);
    const data = await response.json();

    const entries = Array.isArray(data)
        ? data
        : Array.isArray(data.history)
            ? data.history
            : [];

    convs = {};

    for (const entry of entries) {
        const id = getConversationId(entry);

        if (!id) {
            continue;
        }

        if (!convs[id]) {
            convs[id] = [];
        }

        convs[id].push(entry);
    }

    Object.values(convs).forEach(entries => {
        entries.sort((a, b) => {
            return getTimestamp(a) - getTimestamp(b);
        });
    });

    renderSidebar();

    const ids = getSortedConversationIds();

    if (ids.length) {
        openConv(ids[0]);
    } else {
        cur = newId();
        showWelcome();
        renderSidebar();
    }

    setStatus('Connected');
}

// ==================================================
// 7. RENDER HISTORY SIDEBAR
// ==================================================

function renderSidebar() {
    if (!historyBox) {
        return;
    }

    historyBox.replaceChildren();

    const ids = getSortedConversationIds();

    if (!ids.length) {
        const empty = document.createElement('div');

        empty.className = 'empty';
        empty.textContent = 'No conversations yet. Say hello!';

        historyBox.appendChild(empty);
        return;
    }

    let lastGroup = '';

    const today = new Date().toDateString();

    const yesterday = new Date(
        Date.now() - 86400000
    ).toDateString();

    for (const id of ids) {
        const entries = convs[id];

        if (!entries?.length) {
            continue;
        }

        const lastEntry = entries[entries.length - 1];

        const date = new Date(
            lastEntry.timestamp || Date.now()
        ).toDateString();

        let group = 'Previous Conversations';

        if (date === today) {
            group = 'Today';
        } else if (date === yesterday) {
            group = 'Yesterday';
        }

        if (group !== lastGroup) {
            const heading = document.createElement('div');

            heading.className = 'grp';
            heading.textContent = group;

            historyBox.appendChild(heading);

            lastGroup = group;
        }

        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'item' + (id === cur ? ' sel' : '');

        button.textContent =
            getUserMessage(entries[0]) || 'New conversation';

        button.title = button.textContent;

        button.addEventListener('click', () => {
            openConv(id);
        });

        historyBox.appendChild(button);
    }
}

// ==================================================
// 8. WELCOME SCREEN
// ==================================================

function showWelcome() {
    if (!chat) {
        return;
    }

    chat.replaceChildren();

    const template = $('#welcomeTpl');

    if (template) {
        chat.appendChild(template.content.cloneNode(true));
        return;
    }

    const welcome = document.createElement('div');

    welcome.id = 'welcome';

    const heading = document.createElement('h1');
    heading.textContent = 'Hello! I am Second Voice AI.';

    const paragraph = document.createElement('p');

    paragraph.textContent =
        'Ask me anything, practise your English, ' +
        'or talk to me using your voice.';

    welcome.append(heading, paragraph);

    chat.appendChild(welcome);
}

// ==================================================
// 9. DISPLAY MESSAGES
// ==================================================

function bubble(role, text, timestamp) {
    $('#welcome')?.remove();

    const element = document.createElement('div');

    element.className = `msg ${role}`;

    const messageText = document.createElement('div');
    messageText.className = 'message-text';
    messageText.textContent = text;

    element.appendChild(messageText);

    const formattedTime = formatTime(timestamp);

    if (formattedTime) {
        const time = document.createElement('small');

        time.textContent = formattedTime;

        element.appendChild(time);
    }

    chat.appendChild(element);

    chat.scrollTop = chat.scrollHeight;

    return element;
}

// ==================================================
// 10. OPEN CONVERSATION
// ==================================================

function openConv(id) {
    stopVoice({
        showTranscript: false,
        updateStatus: false
    });

    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    generation++;
    busy = false;

    cur = id;

    chat.replaceChildren();

    const entries = convs[id] || [];

    for (const entry of entries) {
        const userMessage = getUserMessage(entry);
        const assistantReply = getAssistantReply(entry);

        if (userMessage) {
            bubble('user', userMessage, entry.timestamp);
        }

        if (assistantReply) {
            bubble('ai', assistantReply, entry.timestamp);
        }
    }

    if (!entries.length) {
        showWelcome();
    }

    updateSend();
    renderSidebar();

    setStatus('Ready');
}

// ==================================================
// 11. NEW CHAT
// ==================================================

async function newChat() {
    stopVoice({
        showTranscript: true
    });

    generation++;

    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    busy = false;

    cur = newId();

    showWelcome();
    renderSidebar();
    updateSend();

    setStatus('Ready');

    try {
        const response = await api(`${API}/api/new-chat`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.conversation_id) {
            cur = data.conversation_id;
        }

        renderSidebar();
    } catch (error) {
        console.warn('New chat:', error.message);
    }
}

// ==================================================
// 12. SEND BUTTON STATE
// ==================================================

function updateSend() {
    if (!sendBtn || !input) {
        return;
    }

    sendBtn.disabled = busy || !input.value.trim();
}

// ==================================================
// 13. SEND TEXT MESSAGE
// ==================================================

async function sendText() {
    const message = input.value.trim();

    if (!message || busy) {
        return;
    }

    // Stop voice mode before switching to text mode.
    if (voice) {
        stopVoice({
            showTranscript: true
        });
    }

    input.value = '';
    input.style.height = 'auto';

    updateSend();

    await ask(message);
}

// ==================================================
// 14. ASK AI
// ==================================================

async function ask(message, options = {}) {
    if (!message.trim() || busy) {
        return null;
    }

    const {
        voiceRequest = false,
        requestGeneration = generation
    } = options;

    const conversationId = cur;

    busy = true;
    updateSend();

    const userTimestamp = new Date().toISOString();

    bubble('user', message, userTimestamp);

    // Add the user's actual recognized words to the transcript.
    if (voiceRequest) {
        voiceTranscript.push({
            role: 'user',
            text: message,
            timestamp: userTimestamp
        });
    }

    const thinking = bubble('ai', 'Thinking...', null);

    thinking.style.opacity = '0.6';

    setStatus('Thinking...', 'busy');

    const controller = new AbortController();

    abortController = controller;

    try {
        const response = await api(`${API}/api/chat`, {
            method: 'POST',

            headers: {
                'Content-Type': 'application/json'
            },

            body: JSON.stringify({
                conversation_id: conversationId,
                message
            }),

            signal: controller.signal
        });

        const data = await response.json();

        if (
            requestGeneration !== generation ||
            conversationId !== cur
        ) {
            thinking.remove();
            return null;
        }

        const reply =
            data.reply ??
            data.assistant_reply ??
            data.response ??
            '';

        if (!reply) {
            throw new Error('The AI returned an empty response.');
        }

        thinking.remove();

        const timestamp =
            data.entry?.timestamp ??
            new Date().toISOString();

        // Display the assistant's reply.
        bubble('ai', reply, timestamp);

        const entry = data.entry || {
            conversation_id: conversationId,
            timestamp,
            user_message: message,
            assistant_reply: reply
        };

        if (!convs[conversationId]) {
            convs[conversationId] = [];
        }

        const alreadyStored = convs[conversationId].some(item => {
            return item.id && item.id === entry.id;
        });

        if (!alreadyStored) {
            convs[conversationId].push(entry);
        }

        renderSidebar();

        // Save the assistant's spoken response to the session transcript.
        if (voiceRequest) {
            voiceTranscript.push({
                role: 'assistant',
                text: reply,
                timestamp
            });
        }

        return reply;

    } catch (error) {
        thinking.remove();

        if (error.name === 'AbortError') {
            return null;
        }

        if (
            requestGeneration === generation &&
            conversationId === cur
        ) {
            toast(error.message);
            setStatus('Error', 'err');
        }

        return null;

    } finally {
        if (abortController === controller) {
            abortController = null;
        }

        if (requestGeneration === generation) {
            busy = false;
            updateSend();

            if (voice && !isStopping) {
                setStatus('Voice mode active', 'rec');
            } else {
                setStatus('Ready');
            }
        }
    }
}

// ==================================================
// 15. STOP CURRENT AUDIO
// ==================================================

function stopAudio() {
    if (!audioPlayer) {
        return;
    }

    const player = audioPlayer;

    // Clear this first so another operation cannot reuse the player.
    audioPlayer = null;

    player.pause();

    player.onended = null;
    player.onerror = null;

    if (player.src && player.src.startsWith('blob:')) {
        URL.revokeObjectURL(player.src);
    }

    player.removeAttribute('src');
    player.load();
}

// ==================================================
// 16. SPLIT TEXT INTO SPEECH CHUNKS
// ==================================================

function splitTextIntoChunks(text, maxLength = 180) {
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];

    const chunks = [];

    let current = '';

    for (let sentence of sentences) {
        sentence = sentence.trim();

        while (sentence.length > maxLength) {
            if (current) {
                chunks.push(current);
                current = '';
            }

            chunks.push(sentence.slice(0, maxLength).trim());

            sentence = sentence.slice(maxLength).trim();
        }

        if ((current + ' ' + sentence).trim().length > maxLength) {
            if (current) {
                chunks.push(current);
            }

            current = sentence;
        } else {
            current = (current + ' ' + sentence).trim();
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks.filter(Boolean);
}

// ==================================================
// 17. PLAY GENERATED AUDIO
// ==================================================

async function playAudioBlob(blob, requestGeneration) {
    if (!blob || !blob.size) {
        throw new Error('The speech service returned empty audio.');
    }

    if (!voice || requestGeneration !== generation) {
        return;
    }

    const audioUrl = URL.createObjectURL(blob);
    const player = new Audio(audioUrl);

    audioPlayer = player;

    await new Promise((resolve, reject) => {
        let finished = false;

        const cleanup = () => {
            if (finished) {
                return;
            }

            finished = true;

            player.onended = null;
            player.onerror = null;

            URL.revokeObjectURL(audioUrl);

            if (audioPlayer === player) {
                audioPlayer = null;
            }
        };

        player.onended = () => {
            cleanup();
            resolve();
        };

        player.onerror = () => {
            cleanup();
            reject(new Error('Could not play the generated audio.'));
        };

        player.play().catch(error => {
            cleanup();
            reject(error);
        });
    });
}

// ==================================================
// 18. AI SPEAKS ITS RESPONSE
// ==================================================

async function speak(text, requestGeneration = generation) {
    if (!text || !voice || isStopping) {
        return false;
    }

    const chunks = splitTextIntoChunks(text);

    for (const chunk of chunks) {
        if (
            !voice ||
            isStopping ||
            requestGeneration !== generation
        ) {
            return false;
        }

        try {
            setStatus('Generating speech...', 'busy');

            const response = await api(`${API}/api/speak`, {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify({
                    text: chunk
                })
            });

            const blob = await response.blob();

            if (
                !voice ||
                isStopping ||
                requestGeneration !== generation
            ) {
                return false;
            }

            await playAudioBlob(blob, requestGeneration);

        } catch (error) {
            console.error('TTS error:', error);

            if (
                voice &&
                !isStopping &&
                requestGeneration === generation
            ) {
                setStatus(
                    'Audio unavailable. Continuing conversation.',
                    'err'
                );

                toast(
                    'Voice output failed. Your AI text reply is still available.'
                );
            }

            // Do not stop the entire voice conversation.
            // listenLoop() can continue to the next recording.
            return false;
        }
    }

    return true;
}

// ==================================================
// 19. RECORD ONE USER UTTERANCE
// ==================================================

function recordUtterance(requestGeneration) {
    return new Promise(async (resolve, reject) => {
        let stream = null;
        let audioContext = null;
        let interval = null;
        let settled = false;
        let hasSpoken = false;

        let lastSound = performance.now();

        const chunks = [];

        let currentRecorder = null;

        const finish = async (error, blob = null) => {
            if (settled) {
                return;
            }

            settled = true;

            clearInterval(interval);

            if (stream) {
                stream.getTracks().forEach(track => {
                    track.stop();
                });
            }

            if (audioContext && audioContext.state !== 'closed') {
                await audioContext.close().catch(() => {});
            }

            if (recorder === currentRecorder) {
                recorder = null;
            }

            isRecording = false;

            if (error) {
                reject(error);
            } else {
                resolve(blob);
            }
        };

        try {
            if (
                !navigator.mediaDevices ||
                !navigator.mediaDevices.getUserMedia
            ) {
                throw new Error(
                    'Microphone access requires localhost or HTTPS.'
                );
            }

            if (typeof MediaRecorder === 'undefined') {
                throw new Error(
                    'Your browser does not support MediaRecorder.'
                );
            }

            stream = await navigator.mediaDevices.getUserMedia({
                audio: true
            });

            if (
                !voice ||
                isStopping ||
                requestGeneration !== generation
            ) {
                await finish(null, null);
                return;
            }

            const options = {};

            if (
                MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ) {
                options.mimeType = 'audio/webm;codecs=opus';
            } else if (
                MediaRecorder.isTypeSupported('audio/webm')
            ) {
                options.mimeType = 'audio/webm';
            }

            currentRecorder = new MediaRecorder(stream, options);
            recorder = currentRecorder;

            audioContext = new AudioContext();

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;

            const source = audioContext.createMediaStreamSource(stream);

            source.connect(analyser);

            const buffer = new Uint8Array(analyser.fftSize);

            const startTime = performance.now();

            isRecording = true;

            currentRecorder.ondataavailable = event => {
                if (event.data?.size > 0) {
                    chunks.push(event.data);
                }
            };

            currentRecorder.onerror = event => {
                finish(
                    event.error || new Error('Audio recording failed.')
                );
            };

            currentRecorder.onstop = async () => {
                const cancelled =
                    !voice ||
                    isStopping ||
                    requestGeneration !== generation;

                if (
                    cancelled ||
                    !hasSpoken ||
                    chunks.length === 0
                ) {
                    await finish(null, null);
                    return;
                }

                const blob = new Blob(chunks, {
                    type: currentRecorder.mimeType || 'audio/webm'
                });

                await finish(null, blob);
            };

            currentRecorder.start();

            setStatus('Listening... Speak now', 'rec');

            interval = setInterval(() => {
                if (
                    !voice ||
                    isStopping ||
                    requestGeneration !== generation
                ) {
                    if (currentRecorder.state !== 'inactive') {
                        currentRecorder.stop();
                    }

                    return;
                }

                analyser.getByteTimeDomainData(buffer);

                let level = 0;

                for (const value of buffer) {
                    level = Math.max(
                        level,
                        Math.abs(value - 128)
                    );
                }

                const now = performance.now();

                if (level > 10) {
                    hasSpoken = true;
                    lastSound = now;
                }

                const silenceAfterSpeech =
                    hasSpoken &&
                    now - lastSound > 1300;

                const maximumDuration =
                    now - startTime > 30000;

                const noSpeechTimeout =
                    !hasSpoken &&
                    now - startTime > 12000;

                if (
                    silenceAfterSpeech ||
                    maximumDuration ||
                    noSpeechTimeout
                ) {
                    if (currentRecorder.state !== 'inactive') {
                        currentRecorder.stop();
                    }
                }
            }, 100);

        } catch (error) {
            await finish(error);
        }
    });
}

// ==================================================
// 20. TRANSCRIBE USER AUDIO
// ==================================================

async function transcribeAudio(blob) {
    const formData = new FormData();

    let extension = 'webm';

    if (blob.type.includes('mp4')) {
        extension = 'mp4';
    } else if (blob.type.includes('ogg')) {
        extension = 'ogg';
    } else if (blob.type.includes('wav')) {
        extension = 'wav';
    } else if (blob.type.includes('mpeg')) {
        extension = 'mp3';
    }

    formData.append('file', blob, `recording.${extension}`);

    const response = await api(`${API}/api/stt`, {
        method: 'POST',
        body: formData
    });

    const data = await response.json();

    return (
        data.text ??
        data.transcription ??
        ''
    ).trim();
}

// ==================================================
// 21. CONTINUOUS VOICE CONVERSATION
// ==================================================

async function listenLoop(requestGeneration) {
    try {
        while (
            voice &&
            !isStopping &&
            requestGeneration === generation
        ) {
            // Never start recording while the AI is processing a reply.
            if (busy || isRecording || audioPlayer) {
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            let blob = null;

            try {
                blob = await recordUtterance(requestGeneration);
            } catch (error) {
                if (
                    voice &&
                    !isStopping &&
                    requestGeneration === generation
                ) {
                    toast(error.message);

                    await stopVoice({
                        showTranscript: true
                    });
                }

                return;
            }

            if (
                !voice ||
                isStopping ||
                requestGeneration !== generation
            ) {
                return;
            }

            // If the user did not say anything, listen again.
            if (!blob) {
                continue;
            }

            let text = '';

            try {
                setStatus('Recognizing your voice...', 'busy');

                text = await transcribeAudio(blob);

            } catch (error) {
                if (
                    voice &&
                    !isStopping &&
                    requestGeneration === generation
                ) {
                    toast(`Transcription error: ${error.message}`);
                }

                continue;
            }

            if (
                !voice ||
                isStopping ||
                requestGeneration !== generation
            ) {
                return;
            }

            if (!text) {
                toast('I could not hear that clearly. Please try again.');
                continue;
            }

            // Send the recognized sentence to the AI.
            const reply = await ask(text, {
                voiceRequest: true,
                requestGeneration
            });

            if (
                !voice ||
                isStopping ||
                requestGeneration !== generation
            ) {
                return;
            }

            if (!reply) {
                await new Promise(resolve => setTimeout(resolve, 300));
                continue;
            }

            // Speak the AI's response before listening again.
            await speak(reply, requestGeneration);

            if (
                !voice ||
                isStopping ||
                requestGeneration !== generation
            ) {
                return;
            }

            // Loop automatically starts a new recording.
            setStatus('Listening again...', 'rec');
        }

    } finally {
        if (requestGeneration === generation) {
            voiceLoopPromise = null;
        }
    }
}

// ==================================================
// 22. START VOICE CHAT
// ==================================================

function startVoice() {
    if (voice) {
        return;
    }

    if (busy) {
        toast('Please wait for the current response to finish.');
        return;
    }

    voice = true;
    isStopping = false;

    voiceTranscript = [];

    generation++;

    const currentGeneration = generation;

    micBtn?.classList.add('on');

    if (stopBtn) {
        stopBtn.hidden = false;
    }

    if (modeLabel) {
        modeLabel.textContent = 'Voice Mode';
    }

    setStatus('Starting voice chat...', 'rec');

    // Start the continuous listen -> AI reply -> speak cycle.
    voiceLoopPromise = listenLoop(currentGeneration);
}

// ==================================================
// 23. RENDER FINAL VOICE TRANSCRIPT
// ==================================================

function renderVoiceTranscript() {
    if (!chat || voiceTranscript.length === 0) {
        return;
    }

    // Do not erase existing conversation messages.
    const separator = document.createElement('div');

    separator.className = 'transcript-divider';
    separator.textContent = 'Voice Conversation Transcript';

    chat.appendChild(separator);

    for (const item of voiceTranscript) {
        const role = item.role === 'user' ? 'user' : 'ai';

        bubble(role, item.text, item.timestamp);
    }

    chat.scrollTop = chat.scrollHeight;
}

// ==================================================
// 24. STOP VOICE CHAT
// ==================================================

async function stopVoice(options = {}) {
    const {
        showTranscript = true,
        updateStatus = true
    } = options;

    if (!voice && !isStopping) {
        if (updateStatus) {
            setStatus('Ready');
        }

        return;
    }

    isStopping = true;
    voice = false;

    generation++;

    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    stopCurrentRecording();
    stopAudio();

    // Make sure text mode is not blocked.
    busy = false;
    isRecording = false;

    updateSend();

    if (micBtn) {
        micBtn.classList.remove('on');
    }

    if (stopBtn) {
        stopBtn.hidden = true;
    }

    if (modeLabel) {
        modeLabel.textContent = 'Text Mode';
    }

    if (voiceLoopPromise) {
        try {
            await Promise.race([
                voiceLoopPromise,
                new Promise(resolve => setTimeout(resolve, 1500))
            ]);
        } catch (error) {
            console.error('Error stopping voice loop:', error);
        }
    }

    if (showTranscript) {
        renderVoiceTranscript();
    }

    isStopping = false;

    updateSend();

    if (updateStatus) {
        setStatus('Voice chat stopped');
    }
}
// ==================================================
// 25. STOP CURRENT RECORDING
// ==================================================

function stopCurrentRecording() {
    if (recorder && recorder.state !== 'inactive') {
        try {
            recorder.stop();
        } catch (error) {
            console.warn('Could not stop recorder:', error);
        }
    }
}

// ==================================================
// 26. CLEAR CHAT HISTORY
// ==================================================

async function clearHistory() {
    const confirmed = confirm(
        'Delete ALL saved conversations? This action cannot be undone.'
    );

    if (!confirmed) {
        return;
    }

    await stopVoice({
        showTranscript: false
    });

    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    generation++;
    busy = false;

    updateSend();

    try {
        await api(`${API}/api/history`, {
            method: 'DELETE'
        });

        convs = {};
        voiceTranscript = [];
        cur = newId();

        showWelcome();
        renderSidebar();

        setStatus('Ready');

        toast('Chat history cleared successfully.');

    } catch (error) {
        toast(`Could not clear history: ${error.message}`);
    }
}

// ==================================================
// 27. EVENT LISTENERS
// ==================================================

input.addEventListener('input', () => {
    input.style.height = 'auto';

    input.style.height =
        Math.min(input.scrollHeight, 160) + 'px';

    updateSend();
});

input.addEventListener('keydown', event => {
    if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing
    ) {
        event.preventDefault();
        sendText();
    }
});

sendBtn.addEventListener('click', sendText);

micBtn.addEventListener('click', startVoice);

stopBtn.addEventListener('click', () => {
    stopVoice({
        showTranscript: true
    });
});

$('#newChat').addEventListener('click', newChat);

$('#clearBtn').addEventListener('click', clearHistory);

chat.addEventListener('click', event => {
    const button = event.target.closest('.card');

    if (!button) {
        return;
    }

    input.value = button.textContent.trim();
    input.focus();

    input.style.height = 'auto';

    input.style.height =
        Math.min(input.scrollHeight, 160) + 'px';

    updateSend();
});

// ==================================================
// 28. INITIALIZE APPLICATION
// ==================================================

async function initializeApp() {
    setStatus('Connecting...', 'busy');

    try {
        await api(`${API}/api/health`);

        await loadHistory();

        setStatus('Connected');

    } catch (error) {
        setStatus('Offline', 'err');

        showWelcome();
        renderSidebar();

        toast(
            'Cannot connect to Second Voice AI. ' +
            'Start your FastAPI backend and check CORS. ' +
            error.message
        );
    }
}

initializeApp();

