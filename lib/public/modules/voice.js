// Voice module — click-to-toggle STT + auto-TTS playback + voice mode toggle

var micBtn = null;
var ttsToggle = null;
var voiceToggleBtn = null;
var basePath = "/";
var inputEl = null;
var sendBtn = null;
var recording = false;
var mediaRecorder = null;
var audioChunks = [];
var transcribing = false;
var interimTimer = null;
var interimInFlight = false;
var audioQueue = [];
var audioPlaying = false;
var currentAudio = null;
var ttsEnabled = false;
var voiceEnabled = false;

function initVoice(opts) {
  basePath = opts.basePath || "/";
  inputEl = opts.inputEl;
  sendBtn = opts.sendBtn;
  micBtn = document.getElementById("mic-btn");
  ttsToggle = document.getElementById("tts-toggle-input");
  voiceToggleBtn = document.getElementById("voice-toggle-btn");

  if (!micBtn) return;

  // Restore voice mode preference
  try { voiceEnabled = localStorage.getItem("braigi-voice") === "1"; } catch (e) {}
  // Restore TTS preference
  try { ttsEnabled = localStorage.getItem("braigi-tts") === "1"; } catch (e) {}
  if (ttsToggle) ttsToggle.checked = ttsEnabled;

  // Apply initial voice mode state
  applyVoiceMode();

  // Check voice backend availability
  checkVoiceStatus();

  // Mic button: click to toggle recording
  micBtn.addEventListener("click", function () {
    if (recording) stopRecording(); else startRecording();
  });
  micBtn.addEventListener("touchstart", function (e) {
    e.preventDefault();
    if (recording) stopRecording(); else startRecording();
  }, { passive: false });

  // Keyboard shortcut: Space when input not focused (only when voice enabled)
  document.addEventListener("keydown", function (e) {
    if (e.code === "Space" && document.activeElement !== inputEl && !e.repeat && voiceEnabled) {
      e.preventDefault();
      if (recording) stopRecording(); else startRecording();
    }
  });

  // TTS toggle in settings menu
  if (ttsToggle) {
    ttsToggle.addEventListener("change", function () {
      ttsEnabled = ttsToggle.checked;
      try { localStorage.setItem("braigi-tts", ttsEnabled ? "1" : "0"); } catch (e) {}
      if (!ttsEnabled) stopTTS();
    });
  }

  // Voice mode toggle button in header
  if (voiceToggleBtn) {
    voiceToggleBtn.addEventListener("click", function () {
      voiceEnabled = !voiceEnabled;
      try { localStorage.setItem("braigi-voice", voiceEnabled ? "1" : "0"); } catch (e) {}
      if (voiceEnabled) {
        ttsEnabled = true;
        try { localStorage.setItem("braigi-tts", "1"); } catch (e) {}
        if (ttsToggle) ttsToggle.checked = true;
      } else {
        stopTTS();
      }
      applyVoiceMode();
    });
  }
}

function applyVoiceMode() {
  if (!micBtn || !voiceToggleBtn) return;

  // Build icon element safely
  var icon = document.createElement("i");
  icon.setAttribute("data-lucide", voiceEnabled ? "mic" : "mic-off");

  if (voiceEnabled) {
    micBtn.style.display = "";
    voiceToggleBtn.classList.add("active");
    voiceToggleBtn.title = "Voice on (click to disable)";
  } else {
    micBtn.style.display = "none";
    voiceToggleBtn.classList.remove("active");
    voiceToggleBtn.title = "Voice off (click to enable)";
  }

  // Replace icon content
  while (voiceToggleBtn.firstChild) voiceToggleBtn.removeChild(voiceToggleBtn.firstChild);
  voiceToggleBtn.appendChild(icon);

  if (window.lucide) window.lucide.createIcons();
}

function checkVoiceStatus() {
  fetch(basePath + "api/voice/status").then(function (r) { return r.json(); }).then(function (data) {
    if (micBtn) {
      micBtn.disabled = !data.stt;
      micBtn.title = data.stt ? "Click to speak" : "STT backend unavailable";
    }
    if (ttsToggle) {
      ttsToggle.disabled = !data.tts;
    }
  }).catch(function () {});
}

function startRecording() {
  if (recording || transcribing) return;
  recording = true;
  audioChunks = [];
  micBtn.classList.add("recording");

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(50);

  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    var mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    }
    var options = mimeType ? { mimeType: mimeType } : {};
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = function (e) {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      if (interimTimer) { clearInterval(interimTimer); interimTimer = null; }
      if (audioChunks.length === 0) {
        micBtn.classList.remove("recording");
        inputEl.classList.remove("interim-transcription");
        return;
      }
      var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      transcribeAudio(blob);
    };

    // Get data chunks every 2 seconds for live transcription
    mediaRecorder.start(2000);

    // Interim transcription: send accumulated audio every 3 seconds
    interimTimer = setInterval(function () {
      if (audioChunks.length < 2 || interimInFlight || !recording) return;
      interimInFlight = true;
      var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      fetch(basePath + "api/stt", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      }).then(function (r) { return r.json(); }).then(function (data) {
        interimInFlight = false;
        if (!recording) return;
        var text = (data.text || "").trim();
        if (text) {
          inputEl.value = text;
          inputEl.dispatchEvent(new Event("input"));
          inputEl.classList.add("interim-transcription");
        }
      }).catch(function () { interimInFlight = false; });
    }, 3000);
  }).catch(function (err) {
    recording = false;
    micBtn.classList.remove("recording");
    console.error("Microphone access denied:", err);
  });
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  if (interimTimer) { clearInterval(interimTimer); interimTimer = null; }
  if (navigator.vibrate) navigator.vibrate(30);
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    micBtn.classList.remove("recording");
    inputEl.classList.remove("interim-transcription");
  }
}

function transcribeAudio(blob) {
  transcribing = true;
  micBtn.classList.remove("recording");
  micBtn.classList.add("transcribing");

  fetch(basePath + "api/stt", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  }).then(function (r) { return r.json(); }).then(function (data) {
    transcribing = false;
    micBtn.classList.remove("transcribing");
    inputEl.classList.remove("interim-transcription");
    var text = (data.text || "").trim();
    if (!text) return;

    // Final transcription replaces any interim text
    inputEl.value = text;
    inputEl.dispatchEvent(new Event("input"));
    inputEl.focus();
  }).catch(function (err) {
    transcribing = false;
    micBtn.classList.remove("transcribing");
    inputEl.classList.remove("interim-transcription");
    console.error("STT failed:", err);
  });
}

// --- Auto-TTS ---

function voiceOnTurnDone(fullText) {
  if (!voiceEnabled || !ttsEnabled || !fullText) return;
  var cleaned = stripForTTS(fullText);
  if (!cleaned) return;
  // Cap at 2000 chars to avoid long TTS calls
  if (cleaned.length > 2000) cleaned = cleaned.substring(0, 2000);
  enqueueTTS(cleaned);
}

function stripForTTS(text) {
  // Remove fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, "");
  // Remove inline code
  text = text.replace(/`[^`]+`/g, "");
  // Remove heading markers
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic markers
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  // Remove list markers
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");
  // Remove links, keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove image references
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");
  // Collapse whitespace
  text = text.replace(/\n{2,}/g, ". ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return text;
}

function enqueueTTS(text) {
  audioQueue.push(text);
  if (!audioPlaying) playNext();
}

function playNext() {
  if (audioQueue.length === 0) {
    audioPlaying = false;
    currentAudio = null;
    return;
  }
  audioPlaying = true;
  var text = audioQueue.shift();

  fetch(basePath + "api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text }),
  }).then(function (r) {
    if (!r.ok) throw new Error("TTS " + r.status);
    return r.blob();
  }).then(function (blob) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    currentAudio = audio;
    audio.onended = function () {
      URL.revokeObjectURL(url);
      currentAudio = null;
      playNext();
    };
    audio.onerror = function () {
      URL.revokeObjectURL(url);
      currentAudio = null;
      playNext();
    };
    audio.play().catch(function () { playNext(); });
  }).catch(function () {
    playNext();
  });
}

function stopTTS() {
  audioQueue = [];
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  audioPlaying = false;
}

export { initVoice, voiceOnTurnDone, stopTTS };
