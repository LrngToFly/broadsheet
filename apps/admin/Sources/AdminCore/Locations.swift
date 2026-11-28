// Where the agent keeps things (the same places as apps/agent/src/paths.ts), and how to run it.
import Foundation

public struct Locations: Sendable {
    public var home: URL
    public var logs: URL
    public var launchAgent: URL

    public static let standard: Locations = {
        let user = FileManager.default.homeDirectoryForCurrentUser
        return Locations(
            home: user.appending(path: "Library/Application Support/Broadsheet"),
            logs: user.appending(path: "Library/Logs/Broadsheet"),
            launchAgent: user.appending(path: "Library/LaunchAgents/com.thebroadsheet.agent.plist")
        )
    }()

    public init(home: URL, logs: URL, launchAgent: URL) {
        self.home = home
        self.logs = logs
        self.launchAgent = launchAgent
    }

    public var database: URL { home.appending(path: "broadsheet.db") }
    public var config: URL { home.appending(path: "broadsheet.config.json") }

    /// The reader's address from the config file (`readerUrl`), for "Open the Broadsheet"; nil if it isn't set.
    public func readerURL() -> URL? {
        guard let data = try? Data(contentsOf: config),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = json["readerUrl"] as? String, let url = URL(string: s), url.scheme?.hasPrefix("http") == true else { return nil }
        return url
    }
    public var runLock: URL { home.appending(path: "run.lock") }
    public var progress: URL { home.appending(path: "progress.json") }
    /// Written by the agent when it finds the database damaged.
    public var problem: URL { home.appending(path: "problem.json") }
    public var backups: URL { home.appending(path: "backups") }
    public var log: URL { logs.appending(path: "agent.log") }
}

/// How to run the agent's command line, read from the launchd job it installed.
public struct AgentCommand: Sendable, Equatable {
    public var node: String
    public var cli: String
    public var workingDirectory: String?
    public var logFile: String?
    public var path: String?

    /// nil when the job isn't installed (run `broadsheet install`).
    public static func fromLaunchAgent(at url: URL) -> AgentCommand? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return fromPlist(data)
    }

    public static func fromPlist(_ data: Data) -> AgentCommand? {
        guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let args = plist["ProgramArguments"] as? [String], args.count >= 2 else { return nil }
        let env = plist["EnvironmentVariables"] as? [String: String]
        return AgentCommand(
            node: args[0], cli: args[1],
            workingDirectory: plist["WorkingDirectory"] as? String,
            logFile: plist["StandardOutPath"] as? String,
            path: env?["PATH"]
        )
    }
}
