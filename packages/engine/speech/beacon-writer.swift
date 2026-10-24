// beacon-writer <request.json>: one B-roll shot's scene written by Apple's on-device language model (macOS 26's
// Foundation Models): free, offline, no key. Reads {"instructions": "...", "prompt": "..."} and prints {"prompt",
// "why"} on stdout; when Apple Intelligence can't run, says why on stderr and exits 2. The small model gets one shot
// at a time, its span already chosen by Beacon: asked for a whole plan, it echoed the words and ignored lengths.
// Built by scripts/build-tools.ts; B-roll's Plan runs it.
import Foundation
import FoundationModels

struct Request: Decodable {
  let instructions: String
  let prompt: String
}

@Generable
struct Scene: Encodable {
  @Guide(description: "A visual scene for a text-to-video model, 25 to 60 words: subject, action, setting, camera move, light, in the requested look. Describe what is seen, never repeat the spoken words. Example: \"A slow dolly across a sunlit modern office, a laptop on a wooden desk showing glowing abstract shapes, soft morning light, shallow depth of field\"")
  let prompt: String
  @Guide(description: "Under 12 words: what in the talk the scene illustrates")
  let why: String
}

func fail(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

guard CommandLine.arguments.count == 2 else { fail("usage: beacon-writer <request.json>") }

let model = SystemLanguageModel.default
switch model.availability {
case .available:
  break
case .unavailable(.deviceNotEligible):
  fail("this Mac can't run Apple Intelligence: choose OpenAI as the B-roll planner in Settings › AI", 2)
case .unavailable(.appleIntelligenceNotEnabled):
  fail("Apple Intelligence is off: turn it on in System Settings › Apple Intelligence & Siri, or choose OpenAI as the B-roll planner in Settings › AI", 2)
case .unavailable(.modelNotReady):
  fail("Apple's on-device model is still downloading: try again in a few minutes", 2)
case .unavailable(let other):
  fail("Apple's on-device model isn't available (\(other))", 2)
}

guard let input = FileManager.default.contents(atPath: CommandLine.arguments[1]),
  let request = try? JSONDecoder().decode(Request.self, from: input)
else { fail("expected {\"instructions\", \"prompt\"} in \(CommandLine.arguments[1])") }

Task {
  do {
    let session = LanguageModelSession(instructions: request.instructions)
    let response = try await session.respond(to: request.prompt, generating: Scene.self)
    let out = try JSONEncoder().encode(response.content)
    FileHandle.standardOutput.write(out)
    exit(0)
  } catch let error as LanguageModelSession.GenerationError {
    switch error {
    case .exceededContextWindowSize:
      fail("too many words for Apple's on-device model: shorten the clip, or use OpenAI in Settings › AI")
    case .guardrailViolation:
      fail("Apple's on-device model declined these words: type a prompt, or use OpenAI in Settings › AI")
    default:
      fail("Apple's on-device model couldn't write the shots: \(error.localizedDescription)")
    }
  } catch {
    fail("Apple's on-device model couldn't write the shots: \(error.localizedDescription)")
  }
}
RunLoop.main.run()
