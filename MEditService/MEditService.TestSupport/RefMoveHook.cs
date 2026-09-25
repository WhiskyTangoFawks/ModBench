namespace MEditService.TestSupport;

/// <summary>git's own reference-transaction hook in a test repository, so a ref move fails where git
/// itself fails it, as it would with another tool holding the ref.</summary>
public static class RefMoveHook
{
    public static string PathIn(string modFolder) => Path.Combine(modFolder, ".git", "hooks", "reference-transaction");

    /// <summary>Aborts every move of main to a commit whose subject carries <paramref name="text"/>.</summary>
    public static void RefuseMainMovesNaming(string modFolder, string text) =>
        Install(modFolder, "[ \"$1\" = prepared ] || exit 0\n", MainMovesNaming(text, "echo 'main is held by another tool' >&2; exit 1"));

    public static void RefuseEveryMoveOf(string modFolder, string gitRef) =>
        Install(modFolder, "[ \"$1\" = prepared ] || exit 0\n",
            $"  if [ \"$ref\" = '{gitRef}' ]; then echo 'the ref is held by another tool' >&2; exit 1; fi\n");

    /// <summary>Runs <paramref name="shell"/> in the committing work tree once main has moved to a
    /// commit whose subject carries <paramref name="text"/>, and lets the move stand.</summary>
    public static void AfterMainMovesNaming(string modFolder, string text, string shell) =>
        Install(modFolder, "[ \"$1\" = committed ] || exit 0\n", MainMovesNaming(text, shell));

    public static void Remove(string modFolder) => File.Delete(PathIn(modFolder));

    private static string MainMovesNaming(string text, string shell) =>
        $"  if [ \"$ref\" = refs/heads/main ] && git log -1 --format=%s \"$new\" | grep -qF '{text}'; then {shell}; fi\n";

    private static void Install(string modFolder, string phase, string perRef)
    {
        var hook = PathIn(modFolder);
        Directory.CreateDirectory(Path.GetDirectoryName(hook).Require());
        File.WriteAllText(hook, "#!/bin/sh\n" + phase + "while read old new ref; do\n" + perRef + "done\n");
        FileModes.Set(hook, "755");
    }
}
