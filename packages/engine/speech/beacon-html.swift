// beacon-html <request.json>: an HTML page's frames, drawn by WebKit (the WKWebView Beacon's UI already uses), with
// its transparency kept: motion graphics are made this way. Reads {"page", "out", "width", "height", "fps", "frames"};
// writes `out`/f00000.png… and says "frame <n>" on stderr as it goes. Each frame seeks the page to its time: the page's
// `window.__seek(t)` when it has one, else every animation (CSS, Web Animations) paused there. The page is in an
// offscreen window (WebKit paints only a view in one) and snapshotted at 1x, whatever the screen's scale.
// Built by scripts/build-tools.ts.
import AppKit
import WebKit

struct Request: Decodable {
  let page: String
  let out: String
  let width: Int
  let height: Int
  let fps: Double
  let frames: Int
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: beacon-html <request.json>") }
guard let input = FileManager.default.contents(atPath: CommandLine.arguments[1]),
  let request = try? JSONDecoder().decode(Request.self, from: input)
else { fail("expected {\"page\", \"out\", \"width\", \"height\", \"fps\", \"frames\"} in \(CommandLine.arguments[1])") }

let SEEK = """
  if (window.__seek) await window.__seek(t);
  else for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
  await document.fonts.ready;
  return true;
  """

final class Grabber: NSObject, WKNavigationDelegate {
  let request: Request
  let view: WKWebView
  let window: NSWindow
  var frame = 0

  init(_ request: Request) {
    self.request = request
    let size = NSRect(x: 0, y: 0, width: request.width, height: request.height)
    view = WKWebView(frame: size, configuration: WKWebViewConfiguration())
    view.setValue(false, forKey: "drawsBackground")
    window = NSWindow(contentRect: size.offsetBy(dx: -20000, dy: -20000), styleMask: [.borderless], backing: .buffered, defer: false)
    window.backgroundColor = .clear
    window.isOpaque = false
    window.contentView = view
    window.orderBack(nil)
    super.init()
    view.navigationDelegate = self
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { next() }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("the page didn't load: \(error.localizedDescription)") }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("the page didn't load: \(error.localizedDescription)") }

  func next() {
    if frame >= request.frames { exit(0) }
    view.callAsyncJavaScript(SEEK, arguments: ["t": Double(frame) / request.fps], in: nil, in: .page) { result in
      if case .failure(let error) = result { fail("the page couldn't be seeked to frame \(self.frame): \(error.localizedDescription)") }
      let config = WKSnapshotConfiguration()
      config.afterScreenUpdates = true
      // In points: on a Retina screen, a snapshot as wide as the page in pixels would be twice the size.
      config.snapshotWidth = NSNumber(value: Double(self.request.width) / Double(self.window.backingScaleFactor))
      self.view.takeSnapshot(with: config) { image, error in
        guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
          fail("frame \(self.frame) couldn't be drawn: \(error?.localizedDescription ?? "no picture")")
        }
        let path = URL(fileURLWithPath: self.request.out).appendingPathComponent(String(format: "f%05d.png", self.frame))
        do { try png.write(to: path) } catch { fail("frame \(self.frame) couldn't be written: \(error.localizedDescription)") }
        FileHandle.standardError.write(Data("frame \(self.frame + 1)\n".utf8))
        self.frame += 1
        self.next()
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let grabber = Grabber(request)
let page = URL(fileURLWithPath: request.page)
grabber.view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
app.run()
