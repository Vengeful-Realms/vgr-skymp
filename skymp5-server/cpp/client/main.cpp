#include "MessageSerializerFactory.h"
#include "MpClientPlugin.h"
#include <cstdint>
#include <string>
#include <nlohmann/json.hpp>

#ifdef SKYMP_VOICE_CHAT_ENABLED
#include "VoiceChat.h"
#endif

namespace {
MpClientPlugin::State& GetState()
{
  static MpClientPlugin::State g_state;
  return g_state;
}

MessageSerializer& GetMessageSerializer()
{
  static std::shared_ptr<MessageSerializer> g_serializer =
    MessageSerializerFactory::CreateMessageSerializer();
  return *g_serializer;
}

void MySerializeMessage(const char* jsonContent,
                        SLNet::BitStream& outputStream)
{
  GetMessageSerializer().Serialize(jsonContent, outputStream);
}

bool MyDeserializeMessage(const uint8_t* data, size_t length,
                          std::string& outJsonContent)
{
  std::optional<DeserializeResult> result =
    GetMessageSerializer().Deserialize(data, length);
  if (!result) {
    return false;
  }

  // TODO(perf): there should be a faster way to get JS object from binary
  // (without extra json building)
  nlohmann::json outJson;
  result->message->WriteJson(outJson);
  outJsonContent = outJson.dump();
  return true;
}
}

extern "C" {
__declspec(dllexport) const char* MpCommonGetVersion()
{
  return "2.0.0";
}

__declspec(dllexport) void CreateClient(const char* targetHostname,
                                        uint16_t targetPort)
{
  return MpClientPlugin::CreateClient(GetState(), targetHostname, targetPort);
}

__declspec(dllexport) void DestroyClient()
{
  return MpClientPlugin::DestroyClient(GetState());
}

__declspec(dllexport) bool IsConnected()
{
  return MpClientPlugin::IsConnected(GetState());
}

__declspec(dllexport) void Tick(MpClientPlugin::OnPacket onPacket, void* state)
{
  return MpClientPlugin::Tick(GetState(), onPacket, MyDeserializeMessage,
                              state);
}

__declspec(dllexport) void Send(const char* jsonContent, bool reliable)
{
  return MpClientPlugin::Send(GetState(), jsonContent, reliable,
                              MySerializeMessage);
}

__declspec(dllexport) void SendRaw(const void* data, size_t size,
                                   bool reliable)
{
  return MpClientPlugin::SendRaw(GetState(), data, size, reliable);
}

#ifdef SKYMP_VOICE_CHAT_ENABLED

__declspec(dllexport) bool InitVoiceChat(const char* livekitUrl,
                                         const char* token,
                                         int sampleRate, int numChannels)
{
  VoiceChat::Config config;
  config.livekitUrl = livekitUrl;
  config.token = token;
  config.sampleRate = sampleRate > 0 ? sampleRate : 48000;
  config.numChannels = numChannels > 0 ? numChannels : 1;
  return VoiceChat::Initialize(config);
}

__declspec(dllexport) void ShutdownVoiceChat()
{
  VoiceChat::Shutdown();
}

__declspec(dllexport) bool IsVoiceChatInitialized()
{
  return VoiceChat::IsInitialized();
}

__declspec(dllexport) void StartTalking()
{
  VoiceChat::StartTalking();
}

__declspec(dllexport) void StopTalking()
{
  VoiceChat::StopTalking();
}

__declspec(dllexport) bool IsTalking()
{
  return VoiceChat::IsTalking();
}

__declspec(dllexport) void SetVoiceMode(int32_t mode)
{
  VoiceChat::SetVoiceMode(static_cast<VoiceChat::VoiceMode>(mode));
}

__declspec(dllexport) void SetVoiceInputGain(float gain)
{
  VoiceChat::SetInputGain(gain);
}

__declspec(dllexport) void SetVoiceOutputVolume(float volume)
{
  VoiceChat::SetOutputVolume(volume);
}

__declspec(dllexport) void TickVoiceChat()
{
  VoiceChat::Tick();
}

__declspec(dllexport) bool NeedsVoiceReconnect()
{
  return VoiceChat::NeedsReconnect();
}

__declspec(dllexport) void SetVoiceParticipantPosition(
  const char* identity, float x, float y, float z)
{
  VoiceChat::SetParticipantPosition(identity, x, y, z);
}

__declspec(dllexport) void SetVoiceListenerPosition(
  float x, float y, float z, float dirX, float dirY, float dirZ)
{
  VoiceChat::SetListenerPosition(x, y, z, dirX, dirY, dirZ);
}

__declspec(dllexport) void SetVoiceRange(float range)
{
  VoiceChat::SetVoiceRange(range);
}

__declspec(dllexport) void SetVoiceNoiseGateEnabled(bool enabled)
{
  VoiceChat::SetNoiseGateEnabled(enabled);
}

__declspec(dllexport) void SetVoiceNoiseGateThreshold(float threshold)
{
  VoiceChat::SetNoiseGateThreshold(threshold);
}

__declspec(dllexport) void SetVoiceNormalizationEnabled(bool enabled)
{
  VoiceChat::SetNormalizationEnabled(enabled);
}

__declspec(dllexport) void SetVoiceNormalizationTarget(float target)
{
  VoiceChat::SetNormalizationTarget(target);
}

// Returns a JSON array of remote participant identities, e.g. ["player-1-abc","player-2-def"]
// The caller must free the returned string with FreeVoiceString.
__declspec(dllexport) const char* GetVoiceRemoteParticipants()
{
  static std::string result;
  auto identities = VoiceChat::GetRemoteParticipantIdentities();
  result = "[";
  for (size_t i = 0; i < identities.size(); ++i) {
    if (i > 0) result += ",";
    result += "\"" + identities[i] + "\"";
  }
  result += "]";
  return result.c_str();
}

// Returns a JSON object mapping LiveKit identities to local decoded-audio
// activity in the [0, 1] range. The values are consumed with a short release
// on each call, so this is intended for the game-thread voice tick.
__declspec(dllexport) const char* GetVoiceParticipantActivity()
{
  static std::string result;
  nlohmann::json levels = nlohmann::json::object();
  for (const auto& [identity, level] :
       VoiceChat::GetRemoteParticipantVoiceActivity()) {
    levels[identity] = level;
  }
  result = levels.dump();
  return result.c_str();
}

#endif // SKYMP_VOICE_CHAT_ENABLED

}
