// Running the agent's command line: Admin's only way of changing anything (docs/phase-3.md).
import Foundation

public struct CommandResult: Sendable {
    public var status: Int32
    public var output: String
    public var ok: Bool { status == 0 }
}

extension AgentCommand {
    func process(_ args: [String]) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli] + args
        if let dir = workingDirectory { p.currentDirectoryURL = URL(fileURLWithPath: dir) }
        var env = ProcessInfo.processInfo.environment
        if let path { env["PATH"] = path }
        p.environment = env
        return p
    }

    /// Run a command and wait for it, e.g. ["pause", "1h"].
    public func run(_ args: [String]) async throws -> CommandResult {
        let p = process(args)
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        return try await withCheckedThrowingContinuation { cont in
            p.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                cont.resume(returning: CommandResult(status: proc.terminationStatus, output: String(decoding: data, as: UTF8.self)))
            }
            do { try p.run() } catch { cont.resume(throwing: error) }
        }
    }

    /// Start a command and don't wait (Run now), writing its output to the agent's log like a scheduled run.
    public func start(_ args: [String]) throws {
        let p = process(args)
        if let logFile, let log = FileHandle(forWritingAtPath: logFile) {
            log.seekToEndOfFile()
            p.standardOutput = log
            p.standardError = log
        } else {
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
        }
        try p.run()
    }
}

/// The last lines of the agent's log, for the log viewer.
public func tail(_ url: URL, maxBytes: Int = 200_000) -> String {
    guard let h = try? FileHandle(forReadingFrom: url) else { return "" }
    defer { try? h.close() }
    let size = (try? h.seekToEnd()) ?? 0
    try? h.seek(toOffset: size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0)
    let text = String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
    // Drop a partial first line.
    return size > UInt64(maxBytes) ? String(text.drop(while: { $0 != "\n" }).dropFirst()) : text
}
