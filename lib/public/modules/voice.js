// Voice module — click-to-toggle STT + progressive streaming TTS

var micBtn = null;
var ttsToggle = null;
var ttsBtn = null;
var voiceModeToggle = null;
var basePath = "/";
var inputEl = null;
var sendBtn = null;
var recording = false;
var mediaRecorder = null;
var audioChunks = [];
var transcribing = false;
var audioContext = null;
var analyser = null;
var waveformRaf = null;
var waveformCanvas = null;
var audioQueue = [];
var audioPlaying = false;
var currentAudio = null;
var currentFetchController = null;
var prefetchPromise = null;
var prefetchController = null;
var ttsEnabled = false;
var ttsBackendAvailable = true;
var voiceEnabled = false;

// Progressive TTS streaming state
var ttsBuf = "";
var inCodeFence = false;
var TTS_MIN_CHARS = 20;
var sentenceEnd = /[.!?:]\s/;
var voiceInitialized = false;

function initVoice(opts) {
  basePath = opts.basePath || "/";
  inputEl = opts.inputEl;
  sendBtn = opts.sendBtn;
  micBtn = document.getElementById("mic-btn");
  ttsToggle = document.getElementById("tts-toggle-input");
  ttsBtn = document.getElementById("tts-btn");
  voiceModeToggle = document.getElementById("voice-mode-toggle-input");

  if (!micBtn) return;
  if (voiceInitialized) return;
  voiceInitialized = true;

  // Restore preferences
  try { voiceEnabled = localStorage.getItem("braigi-voice") === "1"; } catch (e) {}
  try { ttsEnabled = localStorage.getItem("braigi-tts") === "1"; } catch (e) {}
  if (ttsToggle) ttsToggle.checked = ttsEnabled;
  if (voiceModeToggle) voiceModeToggle.checked = voiceEnabled;

  // Apply initial states
  applyVoiceMode();
  applyTtsState();

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

  // Keyboard shortcuts (only when no text field is focused)
  document.addEventListener("keydown", function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    var isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (document.activeElement && document.activeElement.isContentEditable);
    if (isTyping || e.repeat) return;

    // Space → toggle recording (only when voice enabled)
    if (e.code === "Space" && voiceEnabled) {
      e.preventDefault();
      if (recording) stopRecording(); else startRecording();
    }
    // T → toggle TTS (only when backend is available)
    if (e.key === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && ttsBackendAvailable) {
      e.preventDefault();
      ttsEnabled = !ttsEnabled;
      try { localStorage.setItem("braigi-tts", ttsEnabled ? "1" : "0"); } catch (err) {}
      if (ttsToggle) ttsToggle.checked = ttsEnabled;
      applyTtsState();
      if (!ttsEnabled) stopTTS();
    }
  });

  // TTS toggle in settings menu — syncs with header button
  if (ttsToggle) {
    ttsToggle.addEventListener("change", function () {
      ttsEnabled = ttsToggle.checked;
      try { localStorage.setItem("braigi-tts", ttsEnabled ? "1" : "0"); } catch (e) {}
      applyTtsState();
      if (!ttsEnabled) stopTTS();
    });
  }

  // TTS header button — quick toggle
  if (ttsBtn) {
    ttsBtn.addEventListener("click", function () {
      ttsEnabled = !ttsEnabled;
      try { localStorage.setItem("braigi-tts", ttsEnabled ? "1" : "0"); } catch (e) {}
      if (ttsToggle) ttsToggle.checked = ttsEnabled;
      applyTtsState();
      if (!ttsEnabled) stopTTS();
    });
  }

  // Voice mode toggle in settings menu
  if (voiceModeToggle) {
    voiceModeToggle.addEventListener("change", function () {
      voiceEnabled = voiceModeToggle.checked;
      try { localStorage.setItem("braigi-voice", voiceEnabled ? "1" : "0"); } catch (e) {}
      applyVoiceMode();
    });
  }
}

function applyVoiceMode() {
  if (!micBtn) return;
  micBtn.style.display = voiceEnabled ? "" : "none";
}

function applyTtsState() {
  if (!ttsBtn) return;
  var icon = document.createElement("i");
  icon.setAttribute("data-lucide", ttsEnabled ? "volume-2" : "volume-x");

  while (ttsBtn.firstChild) ttsBtn.removeChild(ttsBtn.firstChild);
  ttsBtn.appendChild(icon);

  if (ttsEnabled) {
    ttsBtn.classList.add("active");
    ttsBtn.title = "TTS on (click to mute)";
  } else {
    ttsBtn.classList.remove("active");
    ttsBtn.title = "TTS off (click to enable)";
  }

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
    ttsBackendAvailable = !!data.tts;
    if (ttsBtn) {
      if (!data.tts) {
        ttsEnabled = false;
        if (ttsToggle) ttsToggle.checked = false;
        ttsBtn.disabled = true;
        ttsBtn.title = "TTS backend unavailable";
        applyTtsState();
      } else {
        ttsBtn.disabled = false;
      }
    }
  }).catch(function () {});
}

function showWaveform() {
  waveformCanvas = document.getElementById("voice-waveform");
  if (!waveformCanvas) return;
  waveformCanvas.classList.remove("hidden");
  if (inputEl) inputEl.classList.add("hidden");
}

function hideWaveform() {
  if (waveformCanvas) waveformCanvas.classList.add("hidden");
  if (inputEl) inputEl.classList.remove("hidden");
}

function startWaveformAnimation(stream) {
  if (!waveformCanvas) return;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    return;
  }
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  var source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  var bufLen = analyser.frequencyBinCount;
  var dataArray = new Uint8Array(bufLen);
  var ctx = waveformCanvas.getContext("2d");
  var BAR_COUNT = 48;
  var smoothed = new Float32Array(BAR_COUNT);

  function draw() {
    waveformRaf = requestAnimationFrame(draw);
    var rect = waveformCanvas.parentElement.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = rect.width;
    var h = 60;
    waveformCanvas.width = w * dpr;
    waveformCanvas.height = h * dpr;
    waveformCanvas.style.width = w + "px";
    waveformCanvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    analyser.getByteFrequencyData(dataArray);

    var gap = 3;
    var totalGap = gap * (BAR_COUNT - 1);
    var barW = Math.max(2, (w - totalGap) / BAR_COUNT);
    var midY = h / 2;
    var maxBarH = h * 0.8;
    var binStep = Math.floor(bufLen / BAR_COUNT);

    for (var i = 0; i < BAR_COUNT; i++) {
      var val = 0;
      for (var j = 0; j < binStep; j++) {
        val += dataArray[i * binStep + j];
      }
      val = val / binStep / 255;
      // Smooth towards target (lerp)
      smoothed[i] += (val - smoothed[i]) * 0.3;
      var barH = Math.max(3, smoothed[i] * maxBarH);
      var x = i * (barW + gap);
      var r = Math.min(barW / 2, barH / 2);
      var top = midY - barH / 2;

      ctx.beginPath();
      ctx.moveTo(x + r, top);
      ctx.lineTo(x + barW - r, top);
      ctx.quadraticCurveTo(x + barW, top, x + barW, top + r);
      ctx.lineTo(x + barW, top + barH - r);
      ctx.quadraticCurveTo(x + barW, top + barH, x + barW - r, top + barH);
      ctx.lineTo(x + r, top + barH);
      ctx.quadraticCurveTo(x, top + barH, x, top + barH - r);
      ctx.lineTo(x, top + r);
      ctx.quadraticCurveTo(x, top, x + r, top);
      ctx.closePath();
      ctx.fillStyle = "rgba(229, 83, 75, " + (0.5 + smoothed[i] * 0.5) + ")";
      ctx.fill();
    }
  }
  draw();
}

function stopWaveformAnimation() {
  if (waveformRaf) { cancelAnimationFrame(waveformRaf); waveformRaf = null; }
  if (audioContext) {
    try { audioContext.close(); } catch (e) {}
    audioContext = null;
    analyser = null;
  }
  hideWaveform();
}

function startRecording() {
  if (recording || transcribing) return;
  stopTTS();
  recording = true;
  audioChunks = [];
  micBtn.classList.add("recording");
  showWaveform();

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(50);

  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    // Race guard: user may have stopped recording during async getUserMedia
    if (!recording) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      hideWaveform();
      return;
    }
    // Start waveform visualizer from mic stream
    startWaveformAnimation(stream);

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
      stopWaveformAnimation();
      if (audioChunks.length === 0) {
        micBtn.classList.remove("recording");
        return;
      }
      var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      transcribeAudio(blob);
    };

    // Record continuously — no interim transcription, just collect audio
    mediaRecorder.start();
  }).catch(function (err) {
    recording = false;
    micBtn.classList.remove("recording");
    stopWaveformAnimation();
    console.error("Microphone access denied:", err);
  });
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  if (navigator.vibrate) navigator.vibrate(30);
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    micBtn.classList.remove("recording");
  }
}

function transcribeAudio(blob) {
  transcribing = true;
  micBtn.classList.remove("recording");
  micBtn.classList.add("transcribing");

  var blobSizeMB = (blob.size / 1048576).toFixed(1);
  console.log("[STT] Final transcription: " + blobSizeMB + "MB blob");
  fetch(basePath + "api/stt", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  }).then(function (r) {
    if (!r.ok) {
      return r.text().then(function (t) {
        console.error("[STT] Backend error " + r.status + ":", t);
        return { text: "", error: t };
      });
    }
    return r.json();
  }).then(function (data) {
    transcribing = false;
    micBtn.classList.remove("transcribing");
    if (data.error) {
      console.error("[STT] Transcription error:", data.error);
      return;
    }
    var text = (data.text || "").trim();
    if (!text) { console.warn("[STT] Empty transcription result"); return; }

    // Final transcription replaces any interim text
    console.log("[STT] Got " + text.length + " chars");
    inputEl.value = text;
    inputEl.dispatchEvent(new Event("input"));
    inputEl.focus();
  }).catch(function (err) {
    transcribing = false;
    micBtn.classList.remove("transcribing");
    console.error("[STT] Request failed:", err);
  });
}

// --- Progressive streaming TTS ---

function voiceOnDelta(text) {
  if (!ttsEnabled) return;
  ttsBuf += text;
  // Track code fence toggling (odd count = inside fence)
  var fenceMatches = ttsBuf.match(/```/g);
  if (fenceMatches) {
    inCodeFence = fenceMatches.length % 2 === 1;
  }
  if (inCodeFence) return;
  drainSentences();
}

function drainSentences() {
  var match;
  var pending = "";
  while ((match = sentenceEnd.exec(ttsBuf)) !== null) {
    var idx = match.index + match[0].length;
    var chunk = ttsBuf.substring(0, idx);
    ttsBuf = ttsBuf.substring(idx);
    pending += chunk;
    var cleaned = stripForTTS(pending);
    if (cleaned && cleaned.length >= TTS_MIN_CHARS) {
      enqueueTTS(cleaned);
      pending = "";
    }
  }
  // Prepend any short accumulated sentences back to the buffer
  if (pending) ttsBuf = pending + ttsBuf;
}

function voiceOnTurnDone() {
  if (!ttsEnabled) { resetTtsBuf(); return; }
  // Flush remaining buffer (cap at 2000 chars to avoid long TTS calls)
  if (ttsBuf) {
    var cleaned = stripForTTS(ttsBuf);
    if (cleaned) {
      if (cleaned.length > 2000) cleaned = cleaned.substring(0, 2000);
      enqueueTTS(cleaned);
    }
  }
  resetTtsBuf();
}

function resetTtsBuf() {
  ttsBuf = "";
  inCodeFence = false;
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

function fetchTTSBlob(text, controller) {
  return fetch(basePath + "api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text }),
    signal: controller.signal,
  }).then(function (r) {
    if (!r.ok) throw new Error("TTS " + r.status);
    return r.blob();
  });
}

function prefetchNext() {
  if (audioQueue.length === 0 || prefetchPromise) return;
  var text = audioQueue.shift();
  prefetchController = new AbortController();
  prefetchPromise = fetchTTSBlob(text, prefetchController).then(function (blob) {
    prefetchController = null;
    return blob;
  }).catch(function () {
    prefetchController = null;
    prefetchPromise = null;
    // Put the sentence back at the front of the queue so it is not lost
    audioQueue.unshift(text);
    return null;
  });
}

var ttsRetryCount = 0;
var TTS_MAX_RETRIES = 2;

function playNext() {
  if (audioQueue.length === 0 && !prefetchPromise) {
    ttsRetryCount = 0;
    audioPlaying = false;
    currentAudio = null;
    return;
  }
  audioPlaying = true;

  var blobReady;
  var fetchedText = null;
  if (prefetchPromise) {
    blobReady = prefetchPromise;
    prefetchPromise = null;
  } else {
    fetchedText = audioQueue.shift();
    currentFetchController = new AbortController();
    blobReady = fetchTTSBlob(fetchedText, currentFetchController);
  }

  blobReady.then(function (blob) {
    currentFetchController = null;
    if (!blob) {
      // Prefetch returned null and re-queued the text — retry with cap
      ttsRetryCount++;
      if (ttsRetryCount > TTS_MAX_RETRIES) {
        // Drop the failed sentence and move on
        if (audioQueue.length > 0) audioQueue.shift();
        ttsRetryCount = 0;
      }
      playNext();
      return;
    }
    ttsRetryCount = 0;
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    currentAudio = audio;
    // Start prefetching next sentence while this one plays
    prefetchNext();
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
    audio.play().catch(function () {
      URL.revokeObjectURL(url);
      currentAudio = null;
      playNext();
    });
  }).catch(function () {
    currentFetchController = null;
    // Put the sentence back so it is not lost
    if (fetchedText) audioQueue.unshift(fetchedText);
    ttsRetryCount++;
    if (ttsRetryCount > TTS_MAX_RETRIES) {
      // Drop the failed sentence and move on
      if (audioQueue.length > 0) audioQueue.shift();
      ttsRetryCount = 0;
    }
    playNext();
  });
}

function stopTTS() {
  audioQueue = [];
  if (currentFetchController) { currentFetchController.abort(); currentFetchController = null; }
  if (prefetchController) { prefetchController.abort(); prefetchController = null; }
  prefetchPromise = null;
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  audioPlaying = false;
  resetTtsBuf();
}

function cancelRecording() {
  if (!recording) return;
  recording = false;
  audioChunks = []; // prevent onstop from triggering transcribeAudio
  if (navigator.vibrate) navigator.vibrate(30);
  stopWaveformAnimation();
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    if (micBtn) micBtn.classList.remove("recording");
  }
}

function resetVoiceState() {
  // Stop any in-progress recording (discard pending audio)
  if (recording) {
    recording = false;
    audioChunks = [];
    stopWaveformAnimation();
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try { mediaRecorder.stop(); } catch (e) {}
    }
  }
  // Clear stuck transcribing flag
  transcribing = false;
  if (micBtn) {
    micBtn.classList.remove("recording");
    micBtn.classList.remove("transcribing");
  }
  // Stop TTS playback
  stopTTS();
}

export { initVoice, voiceOnDelta, voiceOnTurnDone, stopTTS, resetVoiceState, cancelRecording };
