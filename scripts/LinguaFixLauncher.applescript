set projectDir to "/Users/ehanzou/web/LinguaFix"
set launcherPath to projectDir & "/LinguaFix.command"

tell application "Terminal"
  activate
  do script "cd " & quoted form of projectDir & " && " & quoted form of launcherPath
end tell
