// The one-line state the menu bar shows (PLAN.md §6.3).
import Foundation

public enum AgentState: Sendable, Equatable {
    case notInstalled
    case paused(until: Date)
    case working(n: Int, total: Int, title: String)
    /// Running, but not on Gemma's work (checking mail, publishing).
    case checking
    /// Items are waiting because you're at the Mac (or similar).
    case waiting(reason: String, pending: Int)
    case idle(pending: Int)
    case problem(String)

    public init(_ s: Snapshot) {
        if let error = s.databaseError { self = .problem(error); return }
        if s.running {
            if let p = s.progress { self = .working(n: p.n, total: p.total, title: p.title) } else { self = .checking }
            return
        }
        if let until = s.pausedUntil { self = .paused(until: until); return }
        if !s.installed { self = .notInstalled; return }
        if s.pending > 0, let reason = s.runs.first(where: { $0.stage != "a" })?.deferredReason ?? s.runs.first?.deferredReason {
            self = .waiting(reason: reason, pending: s.pending)
            return
        }
        self = .idle(pending: s.pending)
    }

    /// e.g. "Working (3 of 12)", "Waiting — you're active"
    public var headline: String {
        switch self {
        case .notInstalled: "Not scheduled"
        case .paused(let until): "Paused until \(until.formatted(date: Calendar.current.isDateInToday(until) ? .omitted : .abbreviated, time: .shortened))"
        case .working(let n, let total, _): "Working (\(n) of \(total))"
        case .checking: "Checking mail…"
        case .waiting(let reason, _): "Waiting — \(reason)"
        case .idle: "Idle"
        case .problem: "Can't read the agent's data"
        }
    }

    /// An SF Symbol for the menu bar.
    public var symbol: String {
        switch self {
        case .notInstalled, .problem: "exclamationmark.triangle"
        case .paused: "pause.circle"
        case .working, .checking: "newspaper.fill"
        case .waiting: "hourglass"
        case .idle: "newspaper"
        }
    }
}
