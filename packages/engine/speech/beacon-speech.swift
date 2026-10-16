// beacon-speech <audio> [--locale en-US]: a word-timed transcript from Apple's on-device
// SpeechTranscriber (macOS 26), one JSON word per line on stdout; `progress <seconds>` lines on
// stderr as it goes. Built by scripts/build-tools.ts; Beacon's transcript job runs it.
import AVFoundation
import Foundation
import Speech

struct Word: Encodable {
  let text: String
  let start: Double
  let end: Double
  let p: Double
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: beacon-speech <audio> [--locale en-US]") }
let localeId = args.firstIndex(of: "--locale").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "en-US"

Task {
  do {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
      fail("Apple's transcriber doesn't support \(localeId)")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange, .transcriptionConfidence])
    // The speech assets are macOS's, shared by every app; installed once if this Mac lacks them.
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
    let words = Task {
      var out: [Word] = []
      for try await result in transcriber.results where result.isFinal {
        for run in result.text.runs {
          guard let range = run.audioTimeRange else { continue }
          let text = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
          if text.isEmpty { continue }
          out.append(Word(text: text, start: range.start.seconds, end: range.end.seconds, p: run.transcriptionConfidence ?? 1))
        }
        FileHandle.standardError.write(Data("progress \(result.range.end.seconds)\n".utf8))
      }
      return out
    }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    let encoder = JSONEncoder()
    for word in try await words.value {
      print(String(decoding: try encoder.encode(word), as: UTF8.self))
    }
    exit(0)
  } catch {
    fail("Apple's transcriber failed: \(error.localizedDescription)")
  }
}
dispatchMain()
