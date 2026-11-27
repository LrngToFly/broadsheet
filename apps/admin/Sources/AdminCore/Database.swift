// Read-only access to the agent's SQLite database, through the SQLite library built into macOS.
// Admin never writes the database: changes go through the agent's command line (docs/phase-3.md).
import Foundation
import SQLite3

public enum DatabaseError: Error, CustomStringConvertible {
    case open(String), query(String)
    public var description: String {
        switch self {
        case .open(let m): "Couldn't open the database: \(m)"
        case .query(let m): "Database query failed: \(m)"
        }
    }
}

/// One value from a row: SQLite gives back text, numbers or nothing.
public enum Value: Sendable, Equatable {
    case text(String), int(Int64), real(Double), null

    public var string: String? { if case .text(let s) = self { s } else { nil } }
    public var double: Double? {
        switch self {
        case .int(let i): Double(i)
        case .real(let d): d
        default: nil
        }
    }
    public var int: Int? {
        switch self {
        case .int(let i): Int(i)
        case .real(let d): Int(d)
        default: nil
        }
    }
}

public typealias Row = [String: Value]

public final class Database {
    private var handle: OpaquePointer?

    /// Opens read-only. Safe while the agent is writing: the database is in WAL mode.
    public init(path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else { throw DatabaseError.open("\(path) doesn't exist") }
        if sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            sqlite3_close(handle)
            throw DatabaseError.open(message)
        }
        sqlite3_busy_timeout(handle, 2000)
    }

    deinit { sqlite3_close(handle) }

    public func query(_ sql: String, _ params: [String] = []) throws -> [Row] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.query(String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(stmt) }
        // SQLITE_TRANSIENT: SQLite copies the text, so the Swift string can go away.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, p) in params.enumerated() { sqlite3_bind_text(stmt, Int32(i + 1), p, -1, transient) }

        var rows: [Row] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw DatabaseError.query(String(cString: sqlite3_errmsg(handle))) }
            var row: Row = [:]
            for c in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: row[name] = .real(sqlite3_column_double(stmt, c))
                case SQLITE_NULL: row[name] = .null
                default: row[name] = .text(String(cString: sqlite3_column_text(stmt, c)))
                }
            }
            rows.append(row)
        }
        return rows
    }

    public func scalar(_ sql: String, _ params: [String] = []) throws -> Value {
        try query(sql, params).first?.values.first ?? .null
    }
}
