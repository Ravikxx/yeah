import Foundation
import UIKit
import OnnxRuntimeBindings

// Times the three models the co-pilot uses (the same .onnx files as the website) on this phone:
// on the processor with 1, 4 and 6 threads, and through Core ML (which can use the Neural Engine and GPU).
enum Bench {
    struct Frame { let name: String; let w: Int; let h: Int; let chw: [Float] }

    static func run(_ say: @escaping (String) async -> Void) async {
        let pi = ProcessInfo.processInfo
        await say("\(UIDevice.current.model), iOS \(UIDevice.current.systemVersion), \(pi.activeProcessorCount) cores")
        await say("low power mode: \(pi.isLowPowerModeEnabled ? "ON (slower)" : "off"), thermal: \(thermal(pi.thermalState))")
        await say("")
        do {
            let env = try ORTEnv(loggingLevel: .warning)
            let frames = try ["busy", "mid", "plain"].map { try loadFrame($0) }
            let det = try path("detector"), eyes = try path("resnet18"), lane = try path("reallane")
            let configs: [(String, (ORTSessionOptions) throws -> Void)] = [
                ("CPU, 1 thread", { try $0.setIntraOpNumThreads(1) }),
                ("CPU, 4 threads", { try $0.setIntraOpNumThreads(4) }),
                ("CPU, 6 threads", { try $0.setIntraOpNumThreads(6) }),
                ("Core ML (Neural Engine / GPU)", { o in
                    try o.setIntraOpNumThreads(4)
                    let c = ORTCoreMLExecutionProviderOptions()
                    try o.appendCoreMLExecutionProvider(with: c)
                }),
            ]
            for (name, setup) in configs {
                await say("== \(name)")
                do {
                    let o = try ORTSessionOptions()
                    try setup(o)
                    var total = 0.0
                    // car detector on three real ride frames
                    let t0 = now()
                    let ds = try ORTSession(env: env, modelPath: det, sessionOptions: o)
                    await say("  detector loaded in \(Int(ms(since: t0))) ms")
                    var per: [String] = []; var sum = 0.0
                    for f in frames {
                        let v = try tensor(f.chw, [3, f.h, f.w])
                        let m = try median(runs: 8) { _ = try ds.run(withInputs: ["image": v], outputNames: ["boxes", "labels", "scores"], runOptions: nil) }
                        per.append("\(f.name) \(Int(m))"); sum += m
                    }
                    let detMs = sum / Double(frames.count); total += detMs
                    await say("  detector: " + per.joined(separator: " · ") + " ms   (average \(Int(detMs)))")
                    // picture network
                    let es = try ORTSession(env: env, modelPath: eyes, sessionOptions: o)
                    let ev = try tensor([Float](repeating: 0.4, count: 3 * 224 * 224), [1, 3, 224, 224])
                    let em = try median(runs: 15) { _ = try es.run(withInputs: ["image": ev], outputNames: ["emb"], runOptions: nil) }
                    total += em
                    await say("  picture network: \(Int(em)) ms")
                    // lane finder
                    let ls = try ORTSession(env: env, modelPath: lane, sessionOptions: o)
                    let lv = try tensor([Float](repeating: 0.4, count: 3 * 96 * 240), [1, 3, 96, 240])
                    let lm = try median(runs: 15) { _ = try ls.run(withInputs: ["image": lv], outputNames: ["x"], runOptions: nil) }
                    total += lm
                    await say("  lane finder: \(Int(lm)) ms")
                    await say("  >> a whole look would take about \(Int(total)) ms  (the website takes ~190-360 ms on this phone)")
                } catch {
                    await say("  failed: \(error.localizedDescription)")
                }
                await say("")
            }
            await say("done. Tap Copy results and paste them to Claude.")
        } catch {
            await say("setup failed: \(error.localizedDescription)")
        }
    }

    // MARK: helpers
    static func path(_ name: String) throws -> String {
        guard let p = Bundle.main.path(forResource: name, ofType: "onnx") else { throw NSError(domain: "bench", code: 1, userInfo: [NSLocalizedDescriptionKey: "model \(name).onnx is not in the app"]) }
        return p
    }
    static func now() -> CFAbsoluteTime { CFAbsoluteTimeGetCurrent() }
    static func ms(since t: CFAbsoluteTime) -> Double { (now() - t) * 1000 }
    static func median(runs: Int, _ block: () throws -> Void) throws -> Double {
        try block(); try block() // warm-up
        var t: [Double] = []
        for _ in 0..<runs { let a = now(); try block(); t.append(ms(since: a)) }
        t.sort(); return t[t.count / 2]
    }
    static func tensor(_ chw: [Float], _ shape: [Int]) throws -> ORTValue {
        let data = NSMutableData(length: chw.count * MemoryLayout<Float>.size)!
        chw.withUnsafeBytes { data.replaceBytes(in: NSRange(location: 0, length: chw.count * 4), withBytes: $0.baseAddress!) }
        return try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
    }
    static func loadFrame(_ name: String) throws -> Frame {
        guard let p = Bundle.main.path(forResource: name, ofType: "jpg"), let img = UIImage(contentsOfFile: p), let cg = img.cgImage else {
            throw NSError(domain: "bench", code: 2, userInfo: [NSLocalizedDescriptionKey: "test picture \(name).jpg is missing"])
        }
        let w = cg.width, h = cg.height
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var chw = [Float](repeating: 0, count: 3 * w * h)
        let n = w * h
        for i in 0..<n { chw[i] = Float(rgba[i * 4]) / 255; chw[n + i] = Float(rgba[i * 4 + 1]) / 255; chw[2 * n + i] = Float(rgba[i * 4 + 2]) / 255 }
        return Frame(name: name, w: w, h: h, chw: chw)
    }
    static func thermal(_ s: ProcessInfo.ThermalState) -> String {
        switch s { case .nominal: return "cool"; case .fair: return "warm"; case .serious: return "HOT (slowed)"; case .critical: return "critical"; @unknown default: return "?" }
    }
}
