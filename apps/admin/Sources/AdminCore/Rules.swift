// Rules, your own words and the Hidden list (docs/phase-3.md A4). These views come from the agent as JSON
// (`broadsheet rules --json`, `hidden --json`), the same data the reader's Rules page shows, so the logic behind
// them lives in one place. Changes go back through `broadsheet act` and `broadsheet rule save`.
import Foundation

// ---- What `broadsheet rules --json` returns ---------------------------------------------------------------

public struct RulesData: Sendable, Decodable, Equatable {
    public struct OwnWords: Sendable, Decodable, Equatable { public var text: String; public var updatedAt: String? }
    public struct Learned: Sendable, Decodable, Equatable { public var text: String; public var builtAt: String }
    public var ownWords: OwnWords
    public var learnedProfile: Learned?
    public var suggestions: [Suggestion]
    public var rules: [RuleCard]
    /// The conditions of each check and include rule, for the editor.
    public var exact: [String: ExactRule]
}

public struct RuleCard: Sendable, Decodable, Equatable, Identifiable {
    public var id: String
    public var wording: String
    /// "check", "instruction" or "include".
    public var kind: String
    public var detail: String
    public var source: String?
    /// "active" or "off".
    public var status: String
    public var hits30d: Int
    public var redrafting: Bool
    public var on: Bool { status == "active" }
}

public struct Suggestion: Sendable, Decodable, Equatable, Identifiable {
    public struct From: Sendable, Decodable, Equatable {
        public var kind: String
        public var title: String?
        public var reason: String?
        public var note: String?
        public var text: String?
    }
    public struct Ref: Sendable, Decodable, Equatable, Identifiable { public var id: String; public var title: String; public var source: String }
    public var id: String
    /// "drafting", "ready" or "failed".
    public var status: String
    public var from: From
    public var wording: String?
    public var ruleKind: String?
    public var detail: String?
    public var source: String?
    public var wouldHide: [Ref]
    public var error: String?

    public var fromText: String {
        if from.kind == "typed" { return "You typed: “\(from.text ?? "")”" }
        return "From an item you hid: “\(from.title ?? "")”" + (from.note.map { ", “\($0)”" } ?? "")
    }
}

// ---- Exact rules: the condition editor ----------------------------------------------------------------

public enum ConditionField: String, CaseIterable, Sendable, Codable, Identifiable {
    case sender, domain, subject, listId, body, linksTo, wordCount
    public var id: Self { self }
    public var label: String {
        switch self {
        case .sender: "Sender"
        case .domain: "Sender's domain"
        case .subject: "Subject"
        case .listId: "List"
        case .body: "Text (last 4 days only)"
        case .linksTo: "A link"
        case .wordCount: "Length in words"
        }
    }
    public var ops: [String] { self == .wordCount ? ["lessThan", "greaterThan"] : ["contains", "equals", "matches"] }
    public static func opLabel(_ op: String) -> String {
        ["contains": "contains", "equals": "is", "matches": "matches (regular expression)", "lessThan": "is fewer than", "greaterThan": "is more than"][op] ?? op
    }
}

public struct ConditionDraft: Sendable, Equatable, Codable {
    public let key = UUID()
    public var field: ConditionField
    public var op: String
    /// Text, or the number of words for wordCount.
    public var value: String

    public init(field: ConditionField = .subject, op: String = "contains", value: String = "") {
        self.field = field
        self.op = op
        self.value = value
    }

    enum CodingKeys: String, CodingKey { case field, op, value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        field = try c.decode(ConditionField.self, forKey: .field)
        op = try c.decode(String.self, forKey: .op)
        value = (try? c.decode(String.self, forKey: .value)) ?? (try? c.decode(Int.self, forKey: .value)).map(String.init) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(field, forKey: .field)
        try c.encode(op, forKey: .op)
        if field == .wordCount { try c.encode(Int(value) ?? 0, forKey: .value) } else { try c.encode(value, forKey: .value) }
    }
}

public struct ExactRule: Sendable, Equatable, Codable {
    public var id: String?
    /// "check" (hide matching emails) or "include" (always take them, into a section).
    public var kind: String
    public var wording: String
    public var match: String
    public var conditions: [ConditionDraft]
    /// A source id, or nil for every newsletter.
    public var source: String?
    /// Check rules: "deleted-items" or "leave".
    public var mail: String?
    /// Include rules: a section id.
    public var section: String?
    public var status: String

    public init(id: String? = nil, kind: String = "check", wording: String = "", match: String = "all", conditions: [ConditionDraft] = [ConditionDraft()],
                source: String? = nil, mail: String? = "deleted-items", section: String? = nil, status: String = "active") {
        self.id = id
        self.kind = kind
        self.wording = wording
        self.match = match
        self.conditions = conditions
        self.source = source
        self.mail = mail
        self.section = section
        self.status = status
    }

    /// The JSON `broadsheet rule test|save` takes, with only the fields its kind uses.
    public func json() -> String {
        var copy = self
        if kind == "check" { copy.section = nil; copy.mail = copy.mail ?? "deleted-items" } else { copy.mail = nil }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return String(decoding: (try? enc.encode(copy)) ?? Data("{}".utf8), as: UTF8.self)
    }

    /// Something to fix before testing or saving, or nil.
    public var problem: String? {
        if wording.trimmingCharacters(in: .whitespaces).isEmpty { return "Say what the rule is for, in a few words." }
        if conditions.isEmpty { return "Add at least one condition." }
        for c in conditions {
            if c.field == .wordCount, Int(c.value) == nil { return "The length needs a whole number of words." }
            if c.value.trimmingCharacters(in: .whitespaces).isEmpty { return "Every condition needs a value." }
            if c.op == "matches", (try? NSRegularExpression(pattern: c.value)) == nil { return "“\(c.value)” isn't a valid regular expression." }
        }
        return nil
    }
}

// ---- Answers from the agent ---------------------------------------------------------------------------

public struct RuleTestResult: Sendable, Decodable, Equatable {
    public struct Match: Sendable, Decodable, Equatable { public var subject: String; public var sender: String; public var receivedAt: String; public var decision: String; public var why: String? }
    public var checked: Int
    public var days: Int
    public var matched: [Match]
    public var unknown: Int
}

public struct RuleSaveResult: Sendable, Decodable, Equatable { public var id: String; public var created: Bool; public var hid: Int }
public struct ActResult: Sendable, Decodable, Equatable { public var applied: Int; public var ignored: Int; public var errors: [String] }

public struct HiddenCard: Sendable, Decodable, Equatable, Identifiable {
    public struct Why: Sendable, Decodable, Equatable {
        public var kind: String
        public var reason: String?
        public var note: String?
        public var wording: String?
    }
    public var id: String
    public var title: String
    public var source: String
    public var author: String?
    public var publishedAt: String
    public var url: String?
    public var why: Why

    public var whyText: String {
        switch why.kind {
        case "rule": "Rule: \(why.wording ?? "")"
        case "not-article": "Gemma thought this wasn't an article"
        default: "You hid this" + (why.reason.map { " (\($0))" } ?? "") + (why.note.map { ": “\($0)”" } ?? "")
        }
    }
}

/// The agent prints its JSON answer as the last line that starts with { or [.
public func decodeAnswer<T: Decodable>(_ type: T.Type, from output: String) -> T? {
    guard let line = output.split(separator: "\n").last(where: { $0.hasPrefix("{") || $0.hasPrefix("[") }) else { return nil }
    return try? JSONDecoder().decode(T.self, from: Data(line.utf8))
}

/// One action for `broadsheet act`, e.g. ["type": "unhide", "itemId": "…"].
public func actArgument(_ actions: [[String: Any]]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: actions, options: [.sortedKeys])) ?? Data("[]".utf8)
    return String(decoding: data, as: UTF8.self)
}
