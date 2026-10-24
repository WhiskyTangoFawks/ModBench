namespace MEditService.TestSupport;

public static class GitHooks
{
    public static void Write(string modFolder, string hookName, string script)
    {
        var hooks = Directory.CreateDirectory(Path.Combine(modFolder, ".git", "hooks")).FullName;
        var hook = Path.Combine(hooks, hookName);
        File.WriteAllText(hook, $"#!/bin/sh\n{script}\n");
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(hook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    /// <summary>Refuses every ref update from here on, the one that records a binary Modbench wrote included.</summary>
    public static void RefuseRefUpdates(string modFolder) =>
        Write(modFolder, "reference-transaction", "[ \"$1\" = prepared ] && exit 1\nexit 0");

    /// <summary>Refuses the update that records a binary under this plugin's name, and lets every other
    /// update through, the one that puts the old name back included.</summary>
    public static void RefuseRecordingUnder(string modFolder, string pluginName) =>
        Write(modFolder, "reference-transaction",
            $"[ \"$1\" = prepared ] || exit 0\ngrep -Eq '^[0-9a-f]+ [0-9a-f]*[1-9a-f][0-9a-f]* \\S*/{pluginName}$' && exit 1\nexit 0");
}
