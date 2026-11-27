// The Email page (docs/phase-3.md A6): mailbox settings, skipped mail, _Add, and New newsletters.
import Foundation

public struct LoggedEmail: Sendable, Decodable, Equatable, Identifiable {
    public var key: String
    public var receivedAt: String
    public var sender: String
    public var senderName: String?
    public var subject: String
    public var why: String?
    public var source: String?
    public var id: String { key }
}

/** What `broadsheet mail --json` answers. */
public struct EmailReview: Sendable, Decodable, Equatable {
    public var skipped: [LoggedEmail]
    public var added: [LoggedEmail]
    public var newSources: Int
}

/// A JSON value from the agent: settings can be text, true/false or numbers.
public enum JSONValue: Sendable, Decodable, Equatable {
    case string(String), bool(Bool), number(Double), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .string(try c.decode(String.self)) }
    }
    public var string: String? { if case .string(let s) = self { s } else { nil } }
    public var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
    public var number: Double? { if case .number(let n) = self { n } else { nil } }
    /// As the command line takes it.
    public var argument: String {
        switch self {
        case .string(let s): s
        case .bool(let b): b ? "true" : "false"
        case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
        case .null: ""
        }
    }
}

/** One row of `broadsheet settings --json`. */
public struct SettingRow: Sendable, Decodable, Equatable, Identifiable {
    public var key: String
    public var label: String
    public var value: JSONValue
    public var fromAdmin: Bool
    public var fileValue: JSONValue?
    public var id: String { key }
}
