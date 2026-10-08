using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.TestSupport;

internal static class LastWriteRecord
{
    internal static string RefOfTheOnlyPlugin(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "for-each-ref", "--format=%(refname)", "refs/medit/")
            .Trim();

    internal static void RefuseRefUpdates(string modFolder) =>
        GitHooks.Write(modFolder, "reference-transaction", "[ \"$1\" = prepared ] && exit 1\nexit 0");

    /// <summary>Refuses the update that records a binary under this plugin's name, and lets every other
    /// update through, the one that puts the old name back included.</summary>
    internal static void RefuseRecordingUnder(string modFolder, string pluginName) =>
        RefuseMatching(modFolder, $"^[0-9a-f]+ [0-9a-f]*[1-9a-f][0-9a-f]* \\S*/{pluginName}$");

    internal static void RefuseClearing(string modFolder, string pluginName) =>
        RefuseMatching(modFolder, $"^[0-9a-f]+ 0+ \\S*/{pluginName}$");

    private static void RefuseMatching(string modFolder, string updatePattern) =>
        GitHooks.Write(modFolder, "reference-transaction",
            $"[ \"$1\" = prepared ] || exit 0\ngrep -Eq '{updatePattern}' && exit 1\nexit 0");
}
