on run argv
  set titleText to item 1 of argv
  set htmlText to item 2 of argv
  tell application "Notes"
    set localAccounts to every account whose name is "On My Mac"
    if (count of localAccounts) is not 1 then error "Enable the On My Mac account in Notes before adding an offline note."
    set destinationFolder to default folder of item 1 of localAccounts
    set newNote to make new note at destinationFolder with properties {name:titleText, body:htmlText}
    return id of newNote
  end tell
end run
