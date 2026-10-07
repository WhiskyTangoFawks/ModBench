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
}
