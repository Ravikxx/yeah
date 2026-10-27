import SwiftUI

@main
struct WaymarkBenchApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var log = "Tap Run. It takes about a minute.\nBest results: charged, cool phone, Low Power Mode off, screen on."
    @State private var running = false

    var body: some View {
        VStack(spacing: 12) {
            Text("Waymark Bench").font(.title2.bold())
            ScrollView {
                Text(log)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            HStack {
                Button(running ? "Running…" : "Run speed test") { run() }
                    .buttonStyle(.borderedProminent).disabled(running)
                Button("Copy results") { UIPasteboard.general.string = log }
                    .buttonStyle(.bordered)
            }
        }
        .padding()
    }

    func run() {
        running = true
        log = ""
        Task.detached {
            await Bench.run { line in
                await MainActor.run { log += line + "\n" }
            }
            await MainActor.run { running = false }
        }
    }
}
