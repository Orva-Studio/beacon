// beacon-writer <request.json>: Apple's on-device language model (macOS 26's Foundation Models) writing for Beacon:
// free, offline, no key. Reads {"instructions", "prompt", "kind"} and prints JSON on stdout: `scene` (the default), one
// B-roll shot's {"prompt", "why"}; `idea`, a motion graphic's {"prompt", "why"}; `piece`, the one graphic it is (its
// kind and words; Beacon times and places it). When Apple Intelligence can't run, says why on stderr and exits 2. The small model gets one shot at a
// time, its span already chosen by Beacon: asked for a whole plan, it echoed the words and ignored lengths.
// Built by scripts/build-tools.ts; B-roll's Plan and motion graphics' Write and Make run it.
import Foundation
import FoundationModels

struct Request: Decodable {
  let instructions: String
  let prompt: String
  let kind: String?
}

@Generable
struct Scene: Encodable {
  @Guide(description: "A visual scene for a text-to-video model, 25 to 60 words: subject, action, setting, camera move, light, in the requested look. Describe what is seen, never repeat the spoken words. Example: \"A slow dolly across a sunlit modern office, a laptop on a wooden desk showing glowing abstract shapes, soft morning light, shallow depth of field\"")
  let prompt: String
  @Guide(description: "Under 12 words: what in the talk the scene illustrates")
  let why: String
}

@Generable
struct Idea: Encodable {
  @Guide(description: "One sentence, under 30 words, describing an on-screen motion graphic that shows what is said: a title, a name and role, a number, or a short list, with the exact words or figures it shows. Example: \"The figure 87% counting up, labelled revenue growth this year\"")
  let prompt: String
  @Guide(description: "Under 12 words: what in the talk it shows")
  let why: String
}

@Generable
struct Piece: Encodable {
  @Guide(description: "Which graphic fits: title (a headline), lowerThird (a person's name and role), number (a figure said, counting up), list (2 to 5 things listed), text (one short line)", .anyOf(["title", "lowerThird", "number", "list", "text"]))
  let kind: String
  @Guide(description: "title: its few words; lowerThird: the person's name; number: a short label for the figure; text: the line. Empty for a list. Never the whole sentence")
  let text: String
  @Guide(description: "title: an optional smaller line; lowerThird: the person's role; else empty")
  let detail: String
  @Guide(description: "number: the figure as a plain number (87 for 87%); else 0")
  let value: Double
  @Guide(description: "number: what goes before it, such as $; else empty")
  let prefix: String
  @Guide(description: "number: what goes after it, such as % or x; else empty")
  let suffix: String
  @Guide(description: "list: its 2 to 5 short items, a few words each; else empty", .maximumCount(5))
  let items: [String]
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
    let out: Data
    switch request.kind ?? "scene" {
    case "idea":
      out = try JSONEncoder().encode(try await session.respond(to: request.prompt, generating: Idea.self).content)
    case "piece":
      out = try JSONEncoder().encode(try await session.respond(to: request.prompt, generating: Piece.self).content)
    default:
      out = try JSONEncoder().encode(try await session.respond(to: request.prompt, generating: Scene.self).content)
    }
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
