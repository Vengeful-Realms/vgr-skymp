#pragma once

#ifdef SKYMP_VOICE_CHAT_ENABLED

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace VoiceChat {

enum class VoiceMode : int32_t
{
  Proximity = 0,
  Global = 1
};

struct Config
{
  std::string livekitUrl;
  std::string token;
  int sampleRate = 48000;
  int numChannels = 1;
  float inputGain = 1.0f;
  float outputVolume = 1.0f;
};

// Callback for sending voice token requests to the game server
using RequestTokenCallback =
  std::function<void(const std::string& identity)>;

// Initialize the voice chat system. Must be called once before any other
// voice function. Connects to the LiveKit server using the provided URL
// and access token.
bool Initialize(const Config& config);

// Shut down voice chat and release all resources.
void Shutdown();

// Returns true if voice chat is initialized and connected to a room.
bool IsInitialized();

// Begin capturing and transmitting voice.
void StartTalking();

// Stop capturing and transmitting voice.
void StopTalking();

// Returns true if currently transmitting voice.
bool IsTalking();

// Set voice mode (proximity or global).
void SetVoiceMode(VoiceMode mode);

// Set microphone input gain (0.0 = silent, 1.0 = normal, >1.0 = boost).
void SetInputGain(float gain);

// Set playback volume for received voice (0.0 = silent, 1.0 = normal).
void SetOutputVolume(float volume);

// Must be called from the game thread to process events and audio.
void Tick();

// Returns true if the voice connection was lost and a new token is needed.
// After reading true, the flag is reset to false.
bool NeedsReconnect();

// --- Spatial audio API ---

// Set the 3D position of a remote participant's actor in game coordinates.
// Call each frame from the game thread.
void SetParticipantPosition(const std::string& identity,
                            float x, float y, float z);

// Set the listener (local player) position and forward direction.
// Call each frame from the game thread.
void SetListenerPosition(float x, float y, float z,
                         float dirX, float dirY, float dirZ);

// Set the maximum hearing range in game units.
// Beyond this distance, volume is zero.
void SetVoiceRange(float range);

// --- Microphone post-processing ---

// Enable/disable noise gate. When enabled, audio below the RMS threshold
// is silenced to suppress background noise.
void SetNoiseGateEnabled(bool enabled);

// Set noise gate RMS threshold (0.0–1.0 range, default 0.01).
// Frames with RMS below this value are silenced.
void SetNoiseGateThreshold(float threshold);

// Enable/disable volume normalization (automatic gain control).
// When enabled, quiet speech is boosted and loud speech is attenuated
// toward a target RMS level.
void SetNormalizationEnabled(bool enabled);

// Set the target RMS level for normalization (0.0–1.0, default 0.1).
void SetNormalizationTarget(float target);

// Get list of currently connected remote participant identities.
std::vector<std::string> GetRemoteParticipantIdentities();

// Returns the current decoded-audio activity for each remote participant.
// Values are normalized to [0, 1] and decay as they are read. This is a
// local playback signal; it is not sent over the network.
std::vector<std::pair<std::string, float>> GetRemoteParticipantVoiceActivity();

} // namespace VoiceChat

#endif // SKYMP_VOICE_CHAT_ENABLED
