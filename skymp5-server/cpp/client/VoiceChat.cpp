#ifdef SKYMP_VOICE_CHAT_ENABLED

#include "VoiceChat.h"

#include <livekit/audio_frame.h>
#include <livekit/audio_source.h>
#include <livekit/livekit.h>
#include <livekit/room.h>
#include <livekit/room_delegate.h>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/basic_file_sink.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <set>
#include <thread>
#include <unordered_map>

namespace {
// File logger for voice debug (visible even in DLL context)
std::shared_ptr<spdlog::logger> g_voiceLog;

void EnsureVoiceLogger() {
  if (!g_voiceLog) {
    try {
      // Drop any stale logger from a previous DLL load in the same process
      spdlog::drop("voice_spatial");
      g_voiceLog = spdlog::basic_logger_mt("voice_spatial",
        "Data/SKSE/Plugins/voice_chat_debug.log", true);
      g_voiceLog->set_level(spdlog::level::info);
      g_voiceLog->flush_on(spdlog::level::info);
      g_voiceLog->info("=== Voice spatial logger initialized ===");
    } catch (...) {}
  }
}

#define VOICE_LOG(...) do { \
  EnsureVoiceLogger(); \
  if (g_voiceLog) g_voiceLog->info(__VA_ARGS__); \
} while(0)
} // anon namespace

// ---------------------------------------------------------------------------
// miniaudio config — single-file audio I/O library (header-only)
// We only need capture + playback, no decoding/encoding (LiveKit handles Opus)
// ---------------------------------------------------------------------------
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#include "miniaudio.h"

namespace {

// ---------------------------------------------------------------------------
// Per-participant audio data
// ---------------------------------------------------------------------------
struct ParticipantAudio
{
  std::vector<int16_t> buffer;
  size_t readPos = 0;
  size_t writePos = 0;
  float voiceActivity = 0.0f;

  // 3D position set from the game thread
  float posX = 0.0f;
  float posY = 0.0f;
  float posZ = 0.0f;
  bool hasPosition = false;
};

// ---------------------------------------------------------------------------
// Listener (local player) state
// ---------------------------------------------------------------------------
struct ListenerState
{
  float posX = 0.0f;
  float posY = 0.0f;
  float posZ = 0.0f;
  float dirX = 0.0f;
  float dirY = 1.0f; // default forward = +Y (Skyrim convention)
  float dirZ = 0.0f;
  bool hasPosition = false;
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
struct VoiceChatState
{
  // LiveKit
  livekit::Room room;
  std::shared_ptr<livekit::AudioSource> audioSource;
  std::shared_ptr<livekit::LocalAudioTrack> publishedTrack;

  // miniaudio
  ma_device captureDevice;
  ma_device playbackDevice;
  bool captureDeviceInitialized = false;
  bool playbackDeviceInitialized = false;

  // State
  std::atomic<bool> initialized{ false };
  std::atomic<bool> talking{ false };
  std::atomic<bool> needsReconnect{ false };
  std::atomic<float> inputGain{ 1.0f };
  std::atomic<float> outputVolume{ 1.0f };
  std::atomic<float> voiceRange{ 4000.0f };
  VoiceChat::VoiceMode voiceMode = VoiceChat::VoiceMode::Proximity;

  // Mic post-processing
  std::atomic<bool> noiseGateEnabled{ false };
  std::atomic<float> noiseGateThreshold{ 0.01f }; // RMS threshold (0-1 range, maps to int16 scale internally)
  std::atomic<bool> normalizationEnabled{ false };
  std::atomic<float> normalizationTarget{ 0.1f };  // target RMS (0-1 range)
  std::atomic<float> agcGain{ 1.0f };              // current AGC gain (smoothed)

  // Audio params
  int sampleRate = 48000;

  // Per-participant audio buffers and positions (protected by mutex)
  std::mutex playbackMutex;
  std::unordered_map<std::string, ParticipantAudio> participants;

  // Listener position (protected by playbackMutex)
  ListenerState listener;

  // Track which participants already have audio callbacks registered
  std::set<std::string> callbackRegistered;
};

static std::unique_ptr<VoiceChatState> g_state;

float GetVoiceActivity(const std::vector<int16_t>& samples)
{
  if (samples.empty()) {
    return 0.0f;
  }

  double sumSquares = 0.0;
  for (const int16_t sample : samples) {
    const double normalized = static_cast<double>(sample) / 32768.0;
    sumSquares += normalized * normalized;
  }

  const float rms = static_cast<float>(
    std::sqrt(sumSquares / static_cast<double>(samples.size())));

  // Ignore low-level decoder/background noise and map ordinary speech into
  // the [0, 1] phoneme strength range.
  constexpr float kNoiseFloor = 0.0125f;
  constexpr float kFullSpeechRms = 0.12f;
  const float activity = (rms - kNoiseFloor) /
    (kFullSpeechRms - kNoiseFloor);
  return std::clamp(activity, 0.0f, 1.0f);
}

// ---------------------------------------------------------------------------
// miniaudio capture callback — called from audio thread
// Captures microphone PCM and pushes to LiveKit AudioSource
// ---------------------------------------------------------------------------
void OnCaptureData(ma_device* pDevice, void* /*pOutput*/,
                   const void* pInput, ma_uint32 frameCount)
{
  auto* state = static_cast<VoiceChatState*>(pDevice->pUserData);
  if (!state || !state->talking.load(std::memory_order_relaxed)) {
    return;
  }

  const auto* samples = static_cast<const int16_t*>(pInput);
  const int totalSamples = static_cast<int>(frameCount); // mono

  // Apply input gain
  float gain = state->inputGain.load(std::memory_order_relaxed);
  std::vector<int16_t> gained(samples, samples + totalSamples);
  if (gain != 1.0f) {
    for (auto& s : gained) {
      int32_t v = static_cast<int32_t>(static_cast<float>(s) * gain);
      if (v > 32767)
        v = 32767;
      if (v < -32768)
        v = -32768;
      s = static_cast<int16_t>(v);
    }
  }

  // --- Noise gate ---
  // Silence the frame if its RMS energy is below the threshold.
  // This removes background hiss, fan noise, etc.
  if (state->noiseGateEnabled.load(std::memory_order_relaxed) && totalSamples > 0) {
    float threshold = state->noiseGateThreshold.load(std::memory_order_relaxed);
    // Compute RMS in normalized float range [0, 1]
    double sumSq = 0.0;
    for (int i = 0; i < totalSamples; ++i) {
      double normalized = static_cast<double>(gained[i]) / 32768.0;
      sumSq += normalized * normalized;
    }
    float rms = static_cast<float>(std::sqrt(sumSq / totalSamples));
    if (rms < threshold) {
      // Below threshold — silence the frame
      std::memset(gained.data(), 0, totalSamples * sizeof(int16_t));
    }
  }

  // --- Volume normalization (AGC) ---
  // Smoothly adjust gain so the output RMS approaches the target level.
  // Uses a simple envelope follower with asymmetric attack/release.
  if (state->normalizationEnabled.load(std::memory_order_relaxed) && totalSamples > 0) {
    float target = state->normalizationTarget.load(std::memory_order_relaxed);
    // Compute current frame RMS (normalized 0-1)
    double sumSq = 0.0;
    for (int i = 0; i < totalSamples; ++i) {
      double normalized = static_cast<double>(gained[i]) / 32768.0;
      sumSq += normalized * normalized;
    }
    float rms = static_cast<float>(std::sqrt(sumSq / totalSamples));

    float currentAgcGain = state->agcGain.load(std::memory_order_relaxed);

    if (rms > 0.001f) { // Only adjust when there is actual signal
      float desiredGain = target / rms;
      // Clamp desired gain to a sensible range to avoid blowing up noise
      // or crushing loud signals too hard
      if (desiredGain < 0.1f) desiredGain = 0.1f;
      if (desiredGain > 10.0f) desiredGain = 10.0f;

      // Asymmetric smoothing: fast attack (reduce gain quickly to avoid
      // clipping), slow release (increase gain gently)
      float alpha = (desiredGain < currentAgcGain) ? 0.3f : 0.05f;
      currentAgcGain = currentAgcGain + alpha * (desiredGain - currentAgcGain);
      state->agcGain.store(currentAgcGain, std::memory_order_relaxed);
    }

    // Apply AGC gain
    for (auto& s : gained) {
      int32_t v = static_cast<int32_t>(static_cast<float>(s) * currentAgcGain);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      s = static_cast<int16_t>(v);
    }
  }

  // Push to LiveKit audio source
  livekit::AudioFrame frame(
    gained, state->sampleRate, 1, // mono
    static_cast<int>(frameCount));

  try {
    state->audioSource->captureFrame(frame, 20);
  } catch (const std::exception& e) {
    spdlog::warn("VoiceChat: captureFrame failed: {}", e.what());
  }
}

// ---------------------------------------------------------------------------
// miniaudio playback callback — called from audio thread
// Mixes per-participant audio with 3D spatialization (stereo output)
// ---------------------------------------------------------------------------
void OnPlaybackData(ma_device* pDevice, void* pOutput,
                    const void* /*pInput*/, ma_uint32 frameCount)
{
  auto* state = static_cast<VoiceChatState*>(pDevice->pUserData);
  auto* out = static_cast<int16_t*>(pOutput);
  const size_t totalSamples = static_cast<size_t>(frameCount) * 2; // stereo

  // Zero the output buffer
  for (size_t i = 0; i < totalSamples; ++i) {
    out[i] = 0;
  }

  std::lock_guard<std::mutex> lock(state->playbackMutex);

  float masterVol = state->outputVolume.load(std::memory_order_relaxed);
  float range = state->voiceRange.load(std::memory_order_relaxed);
  bool isProximity =
    (state->voiceMode == VoiceChat::VoiceMode::Proximity);

  for (auto& [identity, pa] : state->participants) {
    size_t available = 0;
    if (pa.writePos >= pa.readPos) {
      available = pa.writePos - pa.readPos;
    }
    if (available == 0) {
      continue;
    }

    // Calculate spatial volume and panning
    float spatialVol = 1.0f;
    float pan = 0.0f; // -1 = full left, +1 = full right, 0 = center

    if (isProximity && pa.hasPosition && state->listener.hasPosition &&
        range > 0.0f) {
      float dx = pa.posX - state->listener.posX;
      float dy = pa.posY - state->listener.posY;
      float dz = pa.posZ - state->listener.posZ;
      float dist = std::sqrt(dx * dx + dy * dy + dz * dz);

      if (dist >= range) {
        // Beyond hearing range — skip this participant entirely
        // but still consume their audio data so buffer doesn't grow
        size_t toConsume =
          (frameCount < available) ? frameCount : available;
        pa.readPos += toConsume;
        if (pa.readPos == pa.writePos) {
          pa.readPos = 0;
          pa.writePos = 0;
          pa.buffer.clear();
        }
        continue;
      }

      // Linear falloff: full volume at distance 0, silence at range
      spatialVol = 1.0f - (dist / range);
      // Clamp
      if (spatialVol < 0.0f) spatialVol = 0.0f;
      if (spatialVol > 1.0f) spatialVol = 1.0f;

      // Stereo panning based on angle between listener forward and
      // direction to speaker (horizontal plane only, ignore Z)
      float distXY = std::sqrt(dx * dx + dy * dy);
      if (distXY > 1.0f) {
        // Normalize direction to speaker
        float toSpeakerX = dx / distXY;
        float toSpeakerY = dy / distXY;

        // Listener's right vector (perpendicular to forward in XY plane)
        // forward = (dirX, dirY), right = (dirY, -dirX)
        float rightX = state->listener.dirY;
        float rightY = -state->listener.dirX;

        // Dot product with right vector gives pan (-1 to +1)
        pan = toSpeakerX * rightX + toSpeakerY * rightY;
        // Clamp
        if (pan < -1.0f) pan = -1.0f;
        if (pan > 1.0f) pan = 1.0f;
      }
    }

    // Constant-power panning: left/right gains
    // pan=0 → equal power both channels
    // pan=-1 → full left, pan=+1 → full right
    float leftGain = std::cos((pan + 1.0f) * 0.25f * 3.14159265f);
    float rightGain = std::sin((pan + 1.0f) * 0.25f * 3.14159265f);

    float finalVol = masterVol * spatialVol;
    leftGain *= finalVol;
    rightGain *= finalVol;

    // Mix this participant's mono samples into stereo output
    size_t samplesToRead =
      (frameCount < available) ? frameCount : available;
    for (size_t i = 0; i < samplesToRead; ++i) {
      int16_t sample = pa.buffer[pa.readPos + i];
      size_t outIdx = i * 2;

      // Accumulate into stereo output (clamping)
      int32_t left = static_cast<int32_t>(out[outIdx]) +
        static_cast<int32_t>(static_cast<float>(sample) * leftGain);
      int32_t right = static_cast<int32_t>(out[outIdx + 1]) +
        static_cast<int32_t>(static_cast<float>(sample) * rightGain);

      if (left > 32767) left = 32767;
      if (left < -32768) left = -32768;
      if (right > 32767) right = 32767;
      if (right < -32768) right = -32768;

      out[outIdx] = static_cast<int16_t>(left);
      out[outIdx + 1] = static_cast<int16_t>(right);
    }

    pa.readPos += samplesToRead;

    // Compact buffer when read catches up
    if (pa.readPos > 0 && pa.readPos == pa.writePos) {
      pa.readPos = 0;
      pa.writePos = 0;
      pa.buffer.clear();
    }
  }
}

// Forward declaration — defined below the delegate
void OnRemoteAudioFrame(const std::string& participantIdentity,
                        const std::string& trackName,
                        const livekit::AudioFrame& frame);

// ---------------------------------------------------------------------------
// Room delegate — receives LiveKit events on internal thread
// ---------------------------------------------------------------------------
class VoiceChatRoomDelegate : public livekit::RoomDelegate
{
public:
  void onTrackSubscribed(livekit::Room& room,
                         const livekit::TrackSubscribedEvent& event) override
  {
    std::string identity = event.participant ? event.participant->identity() : "<unknown>";
    VOICE_LOG("onTrackSubscribed: identity='{}' trackKind={}",
              identity,
              event.track ? static_cast<int>(event.track->kind()) : -1);
    spdlog::info("VoiceChat: remote track subscribed from '{}'", identity);

    // Register audio frame callback NOW — the track is ready
    if (!identity.empty() && identity != "<unknown>") {
      room.setOnAudioFrameCallback(
        identity, livekit::TrackSource::SOURCE_MICROPHONE,
        [identity](const livekit::AudioFrame& frame) {
          OnRemoteAudioFrame(identity, "voice", frame);
        });
      VOICE_LOG("onTrackSubscribed: registered audio callback for '{}'", identity);
    }
  }

  void onTrackUnsubscribed(livekit::Room& room,
                           const livekit::TrackUnsubscribedEvent&) override
  {
    spdlog::info("VoiceChat: remote track unsubscribed");
  }

  void onParticipantConnected(
    livekit::Room& room,
    const livekit::ParticipantConnectedEvent&) override
  {
    spdlog::info("VoiceChat: participant connected");
  }

  void onParticipantDisconnected(
    livekit::Room& room,
    const livekit::ParticipantDisconnectedEvent&) override
  {
    spdlog::info("VoiceChat: participant disconnected");
  }

  void onDisconnected(livekit::Room& room,
                      const livekit::DisconnectedEvent&) override
  {
    spdlog::warn("VoiceChat: disconnected from room — "
                 "will request new token from game server");
    // Signal that we need a fresh token from the game server.
    // We can't reconnect here because the JWT may be expired.
    // The TypeScript layer will detect this via needsReconnect flag
    // and request a new voiceConfig from the server.
    if (g_state) {
      g_state->needsReconnect.store(true, std::memory_order_release);
    }
  }

  void onReconnecting(livekit::Room& room,
                      const livekit::ReconnectingEvent&) override
  {
    spdlog::info("VoiceChat: reconnecting... "
                 "(LiveKit handling automatic ICE restart)");
  }

  void onReconnected(livekit::Room& room,
                     const livekit::ReconnectedEvent&) override
  {
    spdlog::info("VoiceChat: reconnected successfully");
  }
};

static VoiceChatRoomDelegate g_delegate;

// ---------------------------------------------------------------------------
// Audio frame callback — receives decoded PCM from remote participants
// Appends to per-participant ring buffer for spatial playback
// ---------------------------------------------------------------------------
void OnRemoteAudioFrame(const std::string& participantIdentity,
                        const std::string& trackName,
                        const livekit::AudioFrame& frame)
{
  if (!g_state) {
    return;
  }

  const auto& data = frame.data();
  if (data.empty()) {
    return;
  }

  std::lock_guard<std::mutex> lock(g_state->playbackMutex);
  auto it = g_state->participants.find(participantIdentity);
  bool isNew = (it == g_state->participants.end());
  auto& pa = g_state->participants[participantIdentity];
  if (isNew) {
    VOICE_LOG("OnRemoteAudioFrame NEW participant identity='{}'",
                 participantIdentity);
  }
  pa.voiceActivity = std::max(pa.voiceActivity, GetVoiceActivity(data));
  pa.buffer.insert(pa.buffer.end(), data.begin(), data.end());
  pa.writePos += data.size();
}

// ---------------------------------------------------------------------------
// Init / teardown helpers
// ---------------------------------------------------------------------------
bool InitCaptureDevice(VoiceChatState& state)
{
  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.format = ma_format_s16;
  config.capture.channels = 1; // mono mic capture
  config.sampleRate = static_cast<ma_uint32>(state.sampleRate);
  config.periodSizeInFrames = static_cast<ma_uint32>(state.sampleRate / 100);
  config.dataCallback = OnCaptureData;
  config.pUserData = &state;

  if (ma_device_init(nullptr, &config, &state.captureDevice) != MA_SUCCESS) {
    spdlog::error("VoiceChat: failed to init capture device");
    return false;
  }
  state.captureDeviceInitialized = true;

  if (ma_device_start(&state.captureDevice) != MA_SUCCESS) {
    spdlog::error("VoiceChat: failed to start capture device");
    return false;
  }

  spdlog::info("VoiceChat: capture device initialized ({}Hz, mono)",
               state.sampleRate);
  return true;
}

bool InitPlaybackDevice(VoiceChatState& state)
{
  ma_device_config config = ma_device_config_init(ma_device_type_playback);
  config.playback.format = ma_format_s16;
  config.playback.channels = 2; // stereo for spatial panning
  config.sampleRate = static_cast<ma_uint32>(state.sampleRate);
  config.periodSizeInFrames = static_cast<ma_uint32>(state.sampleRate / 100);
  config.dataCallback = OnPlaybackData;
  config.pUserData = &state;

  if (ma_device_init(nullptr, &config, &state.playbackDevice) != MA_SUCCESS) {
    spdlog::error("VoiceChat: failed to init playback device");
    return false;
  }
  state.playbackDeviceInitialized = true;

  if (ma_device_start(&state.playbackDevice) != MA_SUCCESS) {
    spdlog::error("VoiceChat: failed to start playback device");
    return false;
  }

  spdlog::info("VoiceChat: playback device initialized ({}Hz, stereo)",
               state.sampleRate);
  return true;
}

} // anonymous namespace

// ===========================================================================
// Public API
// ===========================================================================

bool VoiceChat::Initialize(const Config& config)
{
  if (g_state && g_state->initialized.load()) {
    spdlog::warn("VoiceChat: already initialized");
    return false;
  }

  // Init LiveKit SDK (global, idempotent)
  livekit::initialize(livekit::LogLevel::Info);

  g_state = std::make_unique<VoiceChatState>();
  g_state->sampleRate = config.sampleRate;
  g_state->inputGain.store(config.inputGain);
  g_state->outputVolume.store(config.outputVolume);

  // Set room delegate
  g_state->room.setDelegate(&g_delegate);

  // Create audio source for mic capture (real-time, mono, no buffering)
  g_state->audioSource =
    std::make_shared<livekit::AudioSource>(config.sampleRate, 1, 0);

  // Connect to LiveKit room
  livekit::RoomOptions options;
  options.auto_subscribe = true;

  if (!g_state->room.Connect(config.livekitUrl, config.token, options)) {
    spdlog::error("VoiceChat: failed to connect to LiveKit room at {}",
                  config.livekitUrl);
    g_state.reset();
    return false;
  }

  spdlog::info("VoiceChat: connected to room at {}", config.livekitUrl);

  // Publish audio track
  auto* lp = g_state->room.localParticipant();
  if (lp) {
    g_state->publishedTrack = lp->publishAudioTrack(
      "voice", g_state->audioSource, livekit::TrackSource::SOURCE_MICROPHONE);
    spdlog::info("VoiceChat: audio track published");
  }

  // Set up audio frame callbacks for all remote participants
  // With auto_subscribe=true, we'll get TrackSubscribed events and can
  // register per-participant callbacks via the room's callback API
  // For now, set a wildcard-style callback using TrackSource
  for (auto& participant : g_state->room.remoteParticipants()) {
    g_state->room.setOnAudioFrameCallback(
      participant->identity(), livekit::TrackSource::SOURCE_MICROPHONE,
      [identity = participant->identity()](const livekit::AudioFrame& frame) {
        OnRemoteAudioFrame(identity, "voice", frame);
      });
  }

  // Init audio devices
  if (!InitCaptureDevice(*g_state)) {
    spdlog::error("VoiceChat: capture device init failed, "
                  "continuing without mic");
  }

  if (!InitPlaybackDevice(*g_state)) {
    spdlog::error("VoiceChat: playback device init failed, "
                  "continuing without speakers");
  }

  g_state->initialized.store(true);
  spdlog::info("VoiceChat: initialized successfully");
  return true;
}

void VoiceChat::Shutdown()
{
  if (!g_state) {
    return;
  }

  g_state->talking.store(false);

  // Stop and uninit audio devices
  if (g_state->captureDeviceInitialized) {
    ma_device_uninit(&g_state->captureDevice);
  }
  if (g_state->playbackDeviceInitialized) {
    ma_device_uninit(&g_state->playbackDevice);
  }

  // Unpublish track and disconnect
  g_state->publishedTrack.reset();
  g_state->audioSource.reset();

  g_state->initialized.store(false);
  g_state.reset();

  spdlog::info("VoiceChat: shut down");
}

bool VoiceChat::IsInitialized()
{
  return g_state && g_state->initialized.load();
}

void VoiceChat::StartTalking()
{
  if (!g_state || !g_state->initialized.load()) {
    spdlog::warn("VoiceChat: StartTalking called but not initialized");
    return;
  }
  g_state->talking.store(true);
  spdlog::info("VoiceChat: started talking");
}

void VoiceChat::StopTalking()
{
  if (!g_state) {
    return;
  }
  g_state->talking.store(false);
  spdlog::info("VoiceChat: stopped talking");
}

bool VoiceChat::IsTalking()
{
  return g_state && g_state->talking.load();
}

void VoiceChat::SetVoiceMode(VoiceMode mode)
{
  if (!g_state || !g_state->initialized.load()) {
    return;
  }

  if (static_cast<int32_t>(mode) < 0 ||
      static_cast<int32_t>(mode) > static_cast<int32_t>(VoiceMode::Global)) {
    spdlog::warn("VoiceChat: invalid voice mode {}, clamping to Proximity",
                 static_cast<int32_t>(mode));
    mode = VoiceMode::Proximity;
  }

  g_state->voiceMode = mode;

  // Communicate mode to the server via participant metadata
  auto* lp = g_state->room.localParticipant();
  if (lp) {
    lp->setMetadata(
      std::string("{\"voiceMode\":") +
      std::to_string(static_cast<int32_t>(mode)) + "}");
  }

  spdlog::info("VoiceChat: voice mode set to {}",
               static_cast<int32_t>(mode));
}

void VoiceChat::SetInputGain(float gain)
{
  if (gain < 0.0f)
    gain = 0.0f;
  if (gain > 5.0f)
    gain = 5.0f;
  if (g_state) {
    g_state->inputGain.store(gain);
  }
}

void VoiceChat::SetOutputVolume(float volume)
{
  if (volume < 0.0f)
    volume = 0.0f;
  if (volume > 5.0f)
    volume = 5.0f;
  if (g_state) {
    g_state->outputVolume.store(volume);
  }
}

void VoiceChat::Tick()
{
  if (!g_state || !g_state->initialized.load()) {
    return;
  }

  // Register audio frame callbacks for newly joined participants
  // This handles participants that join after initialization.
  // onTrackSubscribed also registers callbacks; this is a fallback.
  {
    static int cbLogCounter = 0;
    for (auto& participant : g_state->room.remoteParticipants()) {
      const auto& identity = participant->identity();
      // Only register if not already tracked
      if (g_state->callbackRegistered.find(identity) == g_state->callbackRegistered.end()) {
        g_state->room.setOnAudioFrameCallback(
          identity, livekit::TrackSource::SOURCE_MICROPHONE,
          [identity](const livekit::AudioFrame& frame) {
            OnRemoteAudioFrame(identity, "voice", frame);
          });
        g_state->callbackRegistered.insert(identity);
        VOICE_LOG("Tick: registered audio callback for NEW participant '{}'", identity);
      }
    }
  }

  // Debug: periodically dump participant state
  static int tickCounter = 0;
  if (++tickCounter >= 300) { // ~every 5 seconds at 60fps
    tickCounter = 0;
    std::lock_guard<std::mutex> lock(g_state->playbackMutex);
    if (!g_state->participants.empty()) {
      VOICE_LOG("Tick dump ({} entries, listener.hasPos={}):",
                   g_state->participants.size(), g_state->listener.hasPosition);
      for (auto& [key, p] : g_state->participants) {
        VOICE_LOG("  '{}': hasPos={} pos=({},{},{}) bufAvail={}",
                     key, p.hasPosition, p.posX, p.posY, p.posZ,
                     p.writePos - p.readPos);
      }
    }
  }
}

bool VoiceChat::NeedsReconnect()
{
  if (!g_state) {
    return false;
  }
  // Atomically read and clear the flag
  return g_state->needsReconnect.exchange(false, std::memory_order_acq_rel);
}

// ---------------------------------------------------------------------------
// Spatial audio API
// ---------------------------------------------------------------------------

void VoiceChat::SetParticipantPosition(const std::string& identity,
                                       float x, float y, float z)
{
  if (!g_state) return;
  std::lock_guard<std::mutex> lock(g_state->playbackMutex);
  auto& pa = g_state->participants[identity];
  bool wasNew = !pa.hasPosition;
  pa.posX = x;
  pa.posY = y;
  pa.posZ = z;
  pa.hasPosition = true;
  if (wasNew) {
    VOICE_LOG("SetParticipantPosition NEW identity='{}' pos=({},{},{})",
                 identity, x, y, z);
    // Dump all participant keys for debugging
    for (auto& [key, p] : g_state->participants) {
      VOICE_LOG("  participant key='{}' hasPos={} bufSize={}",
                   key, p.hasPosition, p.writePos - p.readPos);
    }
  }
}

void VoiceChat::SetListenerPosition(float x, float y, float z,
                                    float dirX, float dirY, float dirZ)
{
  if (!g_state) return;
  std::lock_guard<std::mutex> lock(g_state->playbackMutex);
  g_state->listener.posX = x;
  g_state->listener.posY = y;
  g_state->listener.posZ = z;
  // Normalize direction
  float len = std::sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  if (len > 0.001f) {
    g_state->listener.dirX = dirX / len;
    g_state->listener.dirY = dirY / len;
    g_state->listener.dirZ = dirZ / len;
  }
  g_state->listener.hasPosition = true;
}

void VoiceChat::SetVoiceRange(float range)
{
  if (range < 0.0f) range = 0.0f;
  if (g_state) {
    g_state->voiceRange.store(range);
  }
}

void VoiceChat::SetNoiseGateEnabled(bool enabled)
{
  if (g_state) {
    g_state->noiseGateEnabled.store(enabled, std::memory_order_relaxed);
    spdlog::info("VoiceChat: noise gate {}", enabled ? "enabled" : "disabled");
  }
}

void VoiceChat::SetNoiseGateThreshold(float threshold)
{
  if (threshold < 0.0f) threshold = 0.0f;
  if (threshold > 1.0f) threshold = 1.0f;
  if (g_state) {
    g_state->noiseGateThreshold.store(threshold, std::memory_order_relaxed);
  }
}

void VoiceChat::SetNormalizationEnabled(bool enabled)
{
  if (g_state) {
    g_state->normalizationEnabled.store(enabled, std::memory_order_relaxed);
    if (enabled) {
      g_state->agcGain.store(1.0f, std::memory_order_relaxed); // reset on enable
    }
    spdlog::info("VoiceChat: normalization {}", enabled ? "enabled" : "disabled");
  }
}

void VoiceChat::SetNormalizationTarget(float target)
{
  if (target < 0.001f) target = 0.001f;
  if (target > 1.0f) target = 1.0f;
  if (g_state) {
    g_state->normalizationTarget.store(target, std::memory_order_relaxed);
  }
}

std::vector<std::string> VoiceChat::GetRemoteParticipantIdentities()
{
  std::vector<std::string> result;
  if (!g_state || !g_state->initialized.load()) {
    return result;
  }
  for (auto& participant : g_state->room.remoteParticipants()) {
    result.push_back(participant->identity());
  }
  return result;
}

std::vector<std::pair<std::string, float>>
VoiceChat::GetRemoteParticipantVoiceActivity()
{
  std::vector<std::pair<std::string, float>> result;
  if (!g_state || !g_state->initialized.load()) {
    return result;
  }

  std::lock_guard<std::mutex> lock(g_state->playbackMutex);
  result.reserve(g_state->participants.size());
  for (auto& [identity, participant] : g_state->participants) {
    result.emplace_back(identity, participant.voiceActivity);
    participant.voiceActivity *= 0.75f;
    if (participant.voiceActivity < 0.001f) {
      participant.voiceActivity = 0.0f;
    }
  }
  return result;
}

#endif // SKYMP_VOICE_CHAT_ENABLED
