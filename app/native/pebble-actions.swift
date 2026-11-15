import Foundation
import EventKit
import Contacts

struct Action: Decodable {
    let target: String
    let title: String
    let details: String
    let place: String?
    let date: String?
    let time: String?
    let times: [String]?
    let repeatRule: String?
    let occurrences: Int?
    let durationMinutes: Int?
    let person: String?
    let birthYear: Int?
}

func fail(_ text: String) -> Never {
    FileHandle.standardError.write(Data((text + "\n").utf8))
    exit(1)
}

func components(_ date: String?, _ time: String?) -> DateComponents? {
    guard let date, !date.isEmpty else { return nil }
    let parts = date.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3, (2000...2100).contains(parts[0]), (1...12).contains(parts[1]), (1...31).contains(parts[2]) else { return nil }
    var c = DateComponents(year: parts[0], month: parts[1], day: parts[2])
    if let time, !time.isEmpty {
        let t = time.split(separator: ":").compactMap { Int($0) }
        guard t.count == 2, (0...23).contains(t[0]), (0...59).contains(t[1]) else { return nil }
        c.hour = t[0]; c.minute = t[1]
    }
    guard let made = Calendar.current.date(from: c) else { return nil }
    let check = Calendar.current.dateComponents([.year, .month, .day], from: made)
    guard check.year == c.year && check.month == c.month && check.day == c.day else { return nil }
    c.calendar = Calendar.current
    c.timeZone = TimeZone.current
    return c
}

func recurrence(_ rule: String?, _ count: Int?) -> EKRecurrenceRule? {
    guard let rule, rule != "none" else { return nil }
    guard let count, (1...366).contains(count) else { fail("Repeating actions need a reviewed number of occurrences (1–366).") }
    let frequency: EKRecurrenceFrequency = rule == "daily" ? .daily : rule == "weekly" ? .weekly : .yearly
    return EKRecurrenceRule(recurrenceWith: frequency, interval: 1, end: EKRecurrenceEnd(occurrenceCount: count))
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let action = try? JSONDecoder().decode(Action.self, from: input) else { fail("Invalid action details.") }
var granted = false
var accessError: Error?
let gate = DispatchSemaphore(value: 0)
if action.target == "contacts" {
    let contacts = CNContactStore()
    contacts.requestAccess(for: .contacts) { ok, error in granted = ok; accessError = error; gate.signal() }
    if gate.wait(timeout: .now() + 60) == .timedOut { fail("Mac Contacts permission request timed out.") }
    guard granted else { fail(accessError?.localizedDescription ?? "Contacts access was not granted.") }
    guard let person = action.person, !person.isEmpty, let birthday = components(action.date, nil),
          let year = action.birthYear, (1900...Calendar.current.component(.year, from: Date())).contains(year) else {
        fail("Confirm the exact contact name, birthday month/day, and actual birth year.")
    }
    do {
        let keys: [CNKeyDescriptor] = [CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor,
                                       CNContactMiddleNameKey as CNKeyDescriptor, CNContactBirthdayKey as CNKeyDescriptor]
        let found = try contacts.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: person), keysToFetch: keys)
        let exact = found.filter { CNContactFormatter.string(from: $0, style: .fullName)?.localizedCaseInsensitiveCompare(person) == .orderedSame }
        guard exact.count == 1 else { fail("Choose one exact matching name in Contacts first.") }
        let mutable = exact[0].mutableCopy() as! CNMutableContact
        mutable.birthday = DateComponents(year: year, month: birthday.month, day: birthday.day)
        let change = CNSaveRequest()
        change.update(mutable)
        try contacts.execute(change)
        let data = try JSONSerialization.data(withJSONObject: ["ids": [mutable.identifier]])
        FileHandle.standardOutput.write(data)
        exit(0)
    } catch { fail(error.localizedDescription) }
}
let store = EKEventStore()
if action.target == "calendar" {
    store.requestWriteOnlyAccessToEvents { ok, error in granted = ok; accessError = error; gate.signal() }
} else if action.target == "reminders" {
    store.requestFullAccessToReminders { ok, error in granted = ok; accessError = error; gate.signal() }
} else { fail("Unsupported EventKit action.") }
if gate.wait(timeout: .now() + 60) == .timedOut { fail("Mac permission request timed out.") }
guard granted else { fail(accessError?.localizedDescription ?? "Calendar or Reminders access was not granted.") }

var identifiers: [String] = []
do {
    if action.target == "calendar" {
        guard let c = components(action.date, action.time), let start = Calendar.current.date(from: c) else {
            fail("A Calendar event needs a reviewed date and time.")
        }
        guard let calendar = store.calendars(for: .event).first(where: { $0.source.sourceType == .local && $0.allowsContentModifications }) else {
            fail("Create an On My Mac calendar in Calendar before adding an offline event.")
        }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = action.title
        event.startDate = start
        guard let duration = action.durationMinutes, (15...480).contains(duration) else { fail("Choose an event length between 15 and 480 minutes.") }
        event.endDate = start.addingTimeInterval(TimeInterval(duration) * 60)
        event.location = action.place
        event.notes = action.details
        if let rule = recurrence(action.repeatRule, action.occurrences) { event.addRecurrenceRule(rule) }
        try store.save(event, span: .thisEvent, commit: true)
        identifiers.append(event.eventIdentifier ?? "calendar-event-created")
    } else {
        guard let calendar = store.calendars(for: .reminder).first(where: { $0.source.sourceType == .local && $0.allowsContentModifications }) else {
            fail("Create an On My Mac list in Reminders before adding an offline reminder.")
        }
        let times = action.times?.isEmpty == false ? action.times! : [action.time ?? ""]
        guard times.count <= 8 else { fail("At most eight daily times are supported.") }
        for time in times {
            if action.repeatRule != "none" && action.date == nil { fail("A repeating reminder needs a start date.") }
            let due = components(action.date, time)
            if action.date != nil && due == nil { fail("The reminder date or time is invalid.") }
            let reminder = EKReminder(eventStore: store)
            reminder.calendar = calendar
            reminder.title = action.title
            reminder.notes = action.details
            reminder.dueDateComponents = due
            if let rule = recurrence(action.repeatRule, action.occurrences) { reminder.addRecurrenceRule(rule) }
            try store.save(reminder, commit: false)
            identifiers.append(reminder.calendarItemIdentifier)
        }
        try store.commit()
    }
} catch { fail(error.localizedDescription) }
let result = ["ids": identifiers]
let data = try! JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
