document.addEventListener('DOMContentLoaded', () => {
    // --- STAV APLIKACE ---
    const appState = {
        midiOutput: null,
        octave: 4,
        chordType: 'Major',
        activeChordNotes: [],
        activeMelodyNote: null,
        synthPreset: 'Saw',
    };

    // --- AUDIO ENGINE (WEB AUDIO API) ---
    const audio = {
        ctx: null,
        nodes: new Map(), // Skladuje aktivní audio uzly (oscilátory atd.)
        filter: null,
        delay: null,
        reverb: null,
        masterGain: null,
        reverbGain: null,
        delayGain: null,
        attackTime: 0.02,
        releaseTime: 0.2,
    };

    async function setupAudio() {
        if (audio.ctx) return;
        audio.ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Master Gain (celková hlasitost)
        audio.masterGain = audio.ctx.createGain();
        audio.masterGain.gain.value = 0.7;
        audio.masterGain.connect(audio.ctx.destination);

        // Filter
        audio.filter = audio.ctx.createBiquadFilter();
        audio.filter.type = 'lowpass';
        audio.filter.frequency.value = 20000;
        audio.filter.Q.value = 1;
        audio.filter.connect(audio.masterGain);

        // Delay
        audio.delay = audio.ctx.createDelay(1.0);
        const delayFeedback = audio.ctx.createGain();
        delayFeedback.gain.value = 0.5;
        audio.delay.connect(delayFeedback);
        delayFeedback.connect(audio.delay);
        audio.delayGain = audio.ctx.createGain();
        audio.delayGain.gain.value = 0; // Začínáme s vypnutým efektem
        audio.filter.connect(audio.delay);
        audio.delay.connect(audio.delayGain);
        audio.delayGain.connect(audio.masterGain);

        // Reverb (simulovaný pomocí Impulse Response)
        const reverbTime = 2;
        const sampleRate = audio.ctx.sampleRate;
        const length = sampleRate * reverbTime;
        const impulse = audio.ctx.createBuffer(2, length, sampleRate);
        for (let i = 0; i < 2; i++) {
            const channel = impulse.getChannelData(i);
            for (let j = 0; j < length; j++) {
                channel[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, 2.5);
            }
        }
        audio.reverb = audio.ctx.createConvolver();
        audio.reverb.buffer = impulse;
        audio.reverbGain = audio.ctx.createGain();
        audio.reverbGain.gain.value = 0; // Vypnuto
        audio.filter.connect(audio.reverb);
        audio.reverb.connect(audio.reverbGain);
        audio.reverbGain.connect(audio.masterGain);
    }

    // --- SYNTH PRESETY A TVORBA ZVUKU ---
    const synthPresets = {
        Saw: (freq) => [{ type: 'sawtooth', freq: freq, detune: 0 }],
        Sine: (freq) => [{ type: 'sine', freq: freq, detune: 0 }],
        Square: (freq) => [{ type: 'square', freq: freq, detune: 0 }],
        FM: (freq) => {
            const carrier = audio.ctx.createOscillator();
            carrier.type = 'sine';
            carrier.frequency.value = freq;

            const modulator = audio.ctx.createOscillator();
            modulator.type = 'sine';
            modulator.frequency.value = freq * 1.5;

            const modGain = audio.ctx.createGain();
            modGain.gain.value = freq * 2;

            modulator.connect(modGain);
            modGain.connect(carrier.frequency);
            modulator.start();
            return { customNode: carrier, modulator: modulator };
        }
    };

    function createVoice(note) {
        if (!audio.ctx) return;
        const freq = 440 * Math.pow(2, (note - 69) / 12);
        const presetFunc = synthPresets[appState.synthPreset];

        let customNodes = null;
        if (presetFunc(freq).customNode) {
            customNodes = presetFunc(freq);
        }

        const gainNode = audio.ctx.createGain();
        gainNode.gain.setValueAtTime(0, audio.ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, audio.ctx.currentTime + audio.attackTime);
        gainNode.connect(audio.filter);

        const oscillators = [];
        if (customNodes) {
            customNodes.customNode.connect(gainNode);
            customNodes.customNode.start();
            oscillators.push(customNodes.customNode, customNodes.modulator);
        } else {
            presetFunc(freq).forEach(oscDef => {
                const osc = audio.ctx.createOscillator();
                osc.type = oscDef.type;
                osc.frequency.value = oscDef.freq;
                osc.detune.value = oscDef.detune;
                osc.connect(gainNode);
                osc.start();
                oscillators.push(osc);
            });
        }

        audio.nodes.set(note, { oscillators, gainNode });
    }

    function releaseVoice(note) {
        if (!audio.ctx || !audio.nodes.has(note)) return;
        const { oscillators, gainNode } = audio.nodes.get(note);
        const releaseEndTime = audio.ctx.currentTime + audio.releaseTime;
        gainNode.gain.cancelScheduledValues(audio.ctx.currentTime);
        gainNode.gain.setValueAtTime(gainNode.gain.value, audio.ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, releaseEndTime);
        oscillators.forEach(osc => osc.stop(releaseEndTime + 0.1));
        audio.nodes.delete(note);
    }

    // --- OVLÁDÁNÍ AKORDŮ ---
    const chordLogic = {
        'Major': [0, 4, 7], 'Minor': [0, 3, 7],
        'Dim': [0, 3, 6], 'Aug': [0, 4, 8]
    };

    function playChord(rootNote) {
        stopChord();
        const intervals = chordLogic[appState.chordType];
        const notes = intervals.map(i => rootNote + (appState.octave - 4) * 12 + i);
        notes.forEach(note => {
            if (appState.midiOutput) appState.midiOutput.send([0x90, note, 100]);
            else createVoice(note);
        });
        appState.activeChordNotes = notes;
    }

    function stopChord() {
        appState.activeChordNotes.forEach(note => {
            if (appState.midiOutput) appState.midiOutput.send([0x80, note, 0]);
            else releaseVoice(note);
        });
        appState.activeChordNotes = [];
    }

    // --- MELODICKÁ PLOŠKA ---
    const melodyPad = document.getElementById('melody-pad');
    const mPadCtx = melodyPad.getContext('2d');
    let padRect;
    let isPadPressed = false;

    function resizePad() {
        melodyPad.width = melodyPad.clientWidth;
        melodyPad.height = melodyPad.clientHeight;
        padRect = melodyPad.getBoundingClientRect();
        drawPad();
    }

    function drawPad(x = null, y = null) {
        mPadCtx.clearRect(0, 0, melodyPad.width, melodyPad.height);
        if (isPadPressed && x !== null) {
            mPadCtx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            mPadCtx.beginPath();
            mPadCtx.arc(x, y, 20, 0, Math.PI * 2);
            mPadCtx.fill();
        }
    }

    function handlePadMove(e) {
        if (!isPadPressed) return;
        const touch = e.touches ? e.touches[0] : e;
        const x = touch.clientX - padRect.left;
        const y = touch.clientY - padRect.top;

        const relativeY = 1 - (y / melodyPad.height); // 0 (dole) to 1 (nahoře)
        const noteRange = 24; // 2 oktávy
        const baseNote = 60 + (appState.octave - 4) * 12;
        const newNote = Math.round(baseNote + relativeY * noteRange);

        if (newNote !== appState.activeMelodyNote) {
            if (appState.activeMelodyNote !== null) releaseVoice(appState.activeMelodyNote);
            createVoice(newNote);
            appState.activeMelodyNote = newNote;
        }
        drawPad(x, y);
    }

    function startPad(e) {
        e.preventDefault();
        setupAudio();
        isPadPressed = true;
        handlePadMove(e);
    }

    function stopPad() {
        if (!isPadPressed) return;
        isPadPressed = false;
        if (appState.activeMelodyNote !== null) {
            releaseVoice(appState.activeMelodyNote);
            appState.activeMelodyNote = null;
        }
        drawPad();
    }

    // --- OVLÁDÁNÍ KNOBÍKŮ ---
    function setupKnobs() {
        const knobs = document.querySelectorAll('.knob');
        let activeKnob = null;
        let startY, startValue;

        const knobUpdateFunctions = {
            cutoff: (val) => audio.filter.frequency.setTargetAtTime(val * 20000, audio.ctx.currentTime, 0.01),
            resonance: (val) => audio.filter.Q.setTargetAtTime(val * 30, audio.ctx.currentTime, 0.01),
            delay: (val) => audio.delayGain.gain.setTargetAtTime(val, audio.ctx.currentTime, 0.01),
            reverb: (val) => audio.reverbGain.gain.setTargetAtTime(val * 1.5, audio.ctx.currentTime, 0.01),
        };
        const knobValues = { cutoff: 1, resonance: 0, delay: 0, reverb: 0 };

        const updateKnobVisual = (knobEl, value) => {
            const rotation = (value - 0.5) * 270;
            knobEl.style.transform = `rotate(${rotation}deg)`;
        };

        knobs.forEach(knob => {
            const control = knob.dataset.control;
            updateKnobVisual(knob, knobValues[control]);

            const handleStart = (e) => {
                e.preventDefault();
                setupAudio();
                activeKnob = knob;
                startY = (e.touches ? e.touches[0] : e).clientY;
                startValue = knobValues[control];
                document.body.style.cursor = 'ns-resize';
            };
            knob.addEventListener('mousedown', handleStart);
            knob.addEventListener('touchstart', handleStart, { passive: false });
        });

        const handleMove = (e) => {
            if (!activeKnob) return;
            const control = activeKnob.dataset.control;
            const currentY = (e.touches ? e.touches[0] : e).clientY;
            const diff = (startY - currentY) / 200; // citlivost
            let newValue = Math.max(0, Math.min(1, startValue + diff));

            knobValues[control] = newValue;
            updateKnobVisual(activeKnob, newValue);
            knobUpdateFunctions[control](newValue);
        };

        const handleEnd = () => {
            activeKnob = null;
            document.body.style.cursor = 'default';
        };
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('touchmove', handleMove, { passive: false });
        document.addEventListener('mouseup', handleEnd);
        document.addEventListener('touchend', handleEnd);
    }

    // --- INICIALIZACE UI ---
    function initUI() {
        // Akordy
        document.querySelector('#chord-type-selector').addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON') return;
            appState.chordType = e.target.dataset.chord;
            document.querySelectorAll('#chord-type-selector button').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
        });

        document.querySelector('#note-selector').addEventListener('mousedown', e => {
            if (e.target.tagName !== 'BUTTON') return;
            setupAudio();
            playChord(parseInt(e.target.dataset.note));
        });
        document.querySelector('#note-selector').addEventListener('touchstart', e => {
            if (e.target.tagName !== 'BUTTON') return;
            e.preventDefault();
            setupAudio();
            playChord(parseInt(e.target.dataset.note));
        });
        document.body.addEventListener('mouseup', stopChord);
        document.body.addEventListener('touchend', stopChord);

        // Oktáva
        const octaveDisplay = document.getElementById('octave-display');
        document.getElementById('octave-up').addEventListener('click', () => { if (appState.octave < 8) appState.octave++; octaveDisplay.textContent = appState.octave; });
        document.getElementById('octave-down').addEventListener('click', () => { if (appState.octave > 0) appState.octave--; octaveDisplay.textContent = appState.octave; });

        // Presety
        document.querySelector('#synth-preset-selector').addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON') return;
            appState.synthPreset = e.target.dataset.preset;
            document.querySelectorAll('#synth-preset-selector button').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
        });

        // Ploška
        melodyPad.addEventListener('mousedown', startPad);
        melodyPad.addEventListener('touchstart', startPad, { passive: false });
        document.body.addEventListener('mousemove', handlePadMove);
        document.body.addEventListener('touchmove', handlePadMove, { passive: false });
        document.body.addEventListener('mouseup', stopPad);
        document.body.addEventListener('touchend', stopPad);
        window.addEventListener('resize', resizePad);

        resizePad();
        setupKnobs();
        document.getElementById('status').textContent = 'Připraveno';
    }

    initUI();
});