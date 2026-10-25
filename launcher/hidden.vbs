' Starts DarkShed with no window (used by the Windows "run in background" task).
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(here)
sh.CurrentDirectory = root
sh.Run """" & root & "\runtime\node.exe"" """ & here & "\start.mjs"" --no-open", 0, False
