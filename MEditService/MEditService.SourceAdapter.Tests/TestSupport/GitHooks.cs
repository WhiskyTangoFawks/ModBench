namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A hook that runs a script then refuses: another program's write lands before the rollback.</summary>
internal static class GitHooks
{
    internal static void RunThenRefuse(string modFolder, string hookName, string script)
    {
        var hooks = Directory.CreateDirectory(Path.Combine(modFolder, ".git", "hooks")).FullName;
        var hook = Path.Combine(hooks, hookName);
        File.WriteAllText(hook, $"#!/bin/sh\n{script}\nexit 1\n");
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(hook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
}
