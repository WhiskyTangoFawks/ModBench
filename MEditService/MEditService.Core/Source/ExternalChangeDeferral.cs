namespace MEditService.Core.Source;

/// <summary>An unanswered external-change question refuses every write to the mod, compile included
/// (ADR-0041 amendment). The marker caches the classifier's verdict, which alone decides: a present
/// marker is classified again, and nothing found clears it.</summary>
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

    /// <summary>Answering for the mod clears every plugin it holds at once. Also the write gate's, a
    /// settle's and a load's call on a verdict of nothing: the marker never outlives the change it
    /// names.</summary>
    public static void Clear(string modFolder)
    {
        var path = MarkerPath(modFolder);
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>The question's message as last raised, or null — never a throw for an untracked folder
    /// or a missing marker. Non-null is a reason to classify, not yet a reason to refuse.</summary>
    public static string? Unanswered(string modFolder)
    {
        var path = MarkerPath(modFolder);
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }
}
