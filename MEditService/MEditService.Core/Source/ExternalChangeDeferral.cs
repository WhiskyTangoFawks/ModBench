namespace MEditService.Core.Source;

/// <summary>Until an external-change question is answered, the whole mod is refused for editing —
/// every plugin it holds, not just the one that raised the question (ADR-0041 amendment). Same
/// marker-file idiom as <see cref="CompileJournal"/>.</summary>
public static class ExternalChangeDeferral
{
    private const string MarkerFileName = "MEDIT_EXTERNAL_CHANGE";

    private static string MarkerPath(string modFolder) => Path.Combine(modFolder, ".git", MarkerFileName);

    /// <summary><paramref name="question"/> is the exact user-facing message a refused edit gets back, so
    /// the signposting names the real unanswered question rather than a generic "try again later".</summary>
    public static void Set(string modFolder, string question)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        if (!Directory.Exists(gitDir)) return; // repo vanished since Set was called — nothing to persist to.

        var path = MarkerPath(modFolder);
        // Same write-then-rename discipline as CompileJournal's own marker.
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, question);
        File.Move(tempPath, path, overwrite: true);
    }

    /// <summary>Answering for the mod clears every plugin it holds at once — there is no per-plugin
    /// marker left to re-raise.</summary>
    public static void Clear(string modFolder)
    {
        var path = MarkerPath(modFolder);
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>The unanswered question's message, or null — never a throw for an untracked folder or a
    /// missing marker.</summary>
    public static string? Unanswered(string modFolder)
    {
        var path = MarkerPath(modFolder);
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }
}
