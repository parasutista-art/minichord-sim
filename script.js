document.addEventListener('DOMContentLoaded', () => {
    // --- Proměnné pro stav aplikace ---
    let midiAccess = null;
    let midiOutput = null;
    let selectedNote = 60; // C4
    let selectedChordType = 'Major';
    let currentOctave = 4;

    // --- NOVÁ ČÁST: Web Audio API pro interní syntezátor ---
    let audioCtx = null; // "Zvuková karta" prohlížeče
    let activeOscillators = new Map(); // Ukládá oscilátory, které právě hrají
    const attackTime = 0.01; // Rychlý náběh tónu
    const releaseTime = 0.2; // Pomalé doznění tónu

    // --- Odkazy na prvky v HTML ---
    const statusDiv = document.getElementById('status');
    const chordButtons = document.querySelectorAll('#chord-type-selector button');
    const noteButtons = document.querySelectorAll('#note-selector button');
    const octaveUpBtn = document.getElementById('octave-up');
    const octaveDownBtn = document.getElementById('octave-down');
    const octaveDisplay = document.getElementById('octave-display');

    // --- Inicializace MIDI ---
    async function setupMIDI() {
        if (navigator.requestMIDIAccess) {
            try {
                midiAccess = await navigator.requestMIDIAccess();
                const outputs = Array.from(midiAccess.outputs.values());
                if (outputs.length > 0) {
                    midiOutput = outputs[0]; // Použijeme první nalezené zařízení
                    statusDiv.textContent = `Připojeno k: ${midiOutput.name}`;
                } else {
                    // Pokud se nenajde MIDI, připravíme se na interní zvuk
                    statusDiv.textContent = 'Režim: Interní syntezátor';
                }
            } catch (error) {
                statusDiv.textContent = 'Chyba MIDI. Používám interní syntezátor.';
                console.error("MIDI Error:", error);
            }
        } else {
            statusDiv.textContent = 'Režim: Interní syntezátor (Web MIDI není podporováno)';
        }
    }

    // --- Hudební logika (zůstává stejná) ---
    function getChordNotes(rootNote, chordType) {
        const intervals = { 'Major': [0, 4, 7], 'Minor': [0, 3, 7], 'Dim': [0, 3, 6], 'Aug': [0, 4, 8], 'Sus4': [0, 5, 7] };
        return (intervals[chordType] || [0]).map(i => rootNote + i);
    }

    // Funkce pro přepočet MIDI noty na frekvenci (Hz)
    function midiToFrequency(midiNote) {
        return 440 * Math.pow(2, (midiNote - 69) / 12);
    }

    // --- UPRAVENÉ Funkce pro hraní a zastavení ---
    function playChord() {
        const rootNoteWithOctave = selectedNote + (currentOctave - 4) * 12;
        const notesToPlay = getChordNotes(rootNoteWithOctave, selectedChordType);

        if (midiOutput) {
            // Režim 1: Posíláme MIDI ven
            notesToPlay.forEach(note => midiOutput.send([0x90, note, 100]));
        } else {
            // Režim 2: Hrajeme zvuk lokálně
            playLocalSound(notesToPlay);
        }
    }

    function stopChord() {
        if (midiOutput) {
            // Zastavíme MIDI noty
            const rootNoteWithOctave = selectedNote + (currentOctave - 4) * 12;
            const notesToStop = getChordNotes(rootNoteWithOctave, selectedChordType);
            notesToStop.forEach(note => midiOutput.send([0x80, note, 0]));
        } else {
            // Zastavíme lokální zvuk
            stopLocalSound();
        }
    }

    // --- NOVÉ Funkce pro Web Audio API ---
    function playLocalSound(notes) {
        // AudioContext se musí vytvořit až po interakci uživatele (kliknutí)
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        stopLocalSound(); // Nejdřív zastavíme, co hrálo předtím

        notes.forEach(note => {
            const osc = audioCtx.createOscillator(); // Vytvoří zdroj zvuku
            const gainNode = audioCtx.createGain(); // Vytvoří ovládání hlasitosti

            osc.type = 'sawtooth'; // Tvar vlny (další možnosti: 'sine', 'square', 'triangle')
            osc.frequency.setValueAtTime(midiToFrequency(note), audioCtx.currentTime); // Nastaví frekvenci (tón)

            // Obálka hlasitosti (ADSR) - jednoduchá verze
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.7, audioCtx.currentTime + attackTime); // Attack

            // Propojení: oscilátor -> hlasitost -> reproduktory
            osc.connect(gainNode).connect(audioCtx.destination);
            osc.start();

            activeOscillators.set(note, { osc, gainNode }); // Uložíme si referenci
        });
    }

    function stopLocalSound() {
        activeOscillators.forEach((components, note) => {
            const { osc, gainNode } = components;
            // Plynulé ztišení (Release) a následné zastavení a smazání
            gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + releaseTime);

            osc.stop(audioCtx.currentTime + releaseTime + 0.05);
        });
        activeOscillators.clear();
    }

    // --- Přiřazení událostí tlačítkům (upraveno) ---
    chordButtons.forEach(button => {
        button.addEventListener('click', () => {
            chordButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            selectedChordType = button.dataset.chord;
        });
    });

    noteButtons.forEach(button => {
        const playAction = (e) => {
            e.preventDefault();
            selectedNote = parseInt(button.dataset.note);
            playChord();
        };
        button.addEventListener('mousedown', playAction);
        button.addEventListener('touchstart', playAction, { passive: false });
    });

    document.addEventListener('mouseup', stopChord);
    document.addEventListener('touchend', stopChord);

    octaveUpBtn.addEventListener('click', () => { if (currentOctave < 8) currentOctave++; octaveDisplay.textContent = currentOctave; });
    octaveDownBtn.addEventListener('click', () => { if (currentOctave > 0) currentOctave--; octaveDisplay.textContent = currentOctave; });

    // --- Spuštění ---
    setupMIDI();
});